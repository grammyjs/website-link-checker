import { FIXABLE_ISSUE_TYPES } from "./constants.ts";
import { parse, stringify } from "./deps/oson.ts";
import { parseArgs, Spinner } from "./deps/std/cli.ts";
import { blue, bold, cyan, dim, green, red, strikethrough, underline, yellow } from "./deps/std/fmt.ts";
import { extname, join, resolve } from "./deps/std/path.ts";

import { ISSUE_DESCRIPTIONS, ISSUE_TITLES, processIssues } from "./issues.ts";
import { FixableIssue, Issue, IssueWithStack, Stack } from "./types.ts";
import { execute, getPossibleMatches, indentText, parseLink } from "./utilities.ts";
import { readMarkdownFiles } from "./website.ts";

const args = parseArgs(Deno.args, {
  boolean: ["clean-url", "allow-ext-html", "fix"],
  string: ["index-file"],
  default: {
    "index-file": "README.md",
    "allow-ext-html": false,
  },
});

if (args._.length > 1) {
  console.log("Multiple directories were specified. Ignoring everything except the first one.");
}

const rootDirectory = (args._[0] ?? ".").toString();

try {
  const result = await Deno.lstat(join(rootDirectory, "ref"));
  if (!result.isDirectory) throw new Deno.errors.NotFound();
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    console.log("Generating /ref directory");
    const proc = execute(["deno", "task", "docs:genapi"], { cwd: rootDirectory }).spawn();
    if (!(await proc.status).success) {
      console.log("failed to generate API reference documentation. try again");
      Deno.exit(1);
    }
  }
}

if (args.fix) {
  console.warn(
    "%c| %cNote%c: You have specified the --fix argument. This will try to fix all the issues this tool can fix.\n",
    "font-weight: bold",
    "color: orange",
    "color: none",
  );
}

let issues: Record<string, Issue[]> = {};
if (Deno.env.get("DEBUG") != null) {
  console.log("=== DEBUGGING MODE ===");
  try {
    console.log("reading the cache file");
    issues = parse(await Deno.readTextFile("./.link-checker"));
  } catch (_error) {
    console.log("failed to read the cache file");
    issues = await getIssues();
    await Deno.writeTextFile("./.link-checker", stringify(issues));
    console.log("cache file created and will be used next time debugging");
  }
} else {
  console.log("Reading files and checking for bad links...");
  issues = await getIssues();
}

if (Object.keys(issues).length === 0) {
  console.log(green("Found no issues with links in the documentation!"));
  Deno.exit(0);
}

const grouped = await processIssues(issues);
const getIssueTypes = () => Object.keys(grouped) as Issue["type"][];
const getTotal = () => getIssueTypes().reduce((total, type) => total + grouped[type].length, 0);

const initial = getTotal();
console.log("\n" + red(bold(`Found ${initial} issues across the documentation:`)));

let totalPlaces = 0, fixed = 0;

if (args.fix) {
  console.log(blue("note:"), "--fix was specified. trying to fix fixable issues...");
  const spinner = new Spinner({ message: "fixing issues..." });
  spinner.start();

  let fixesMadeThisRound: number, round = 1;
  do {
    fixesMadeThisRound = 0;
    spinner.message = `fixing: round ${round++}`;

    for (const type of getIssueTypes()) {
      if (!isFixableIssueType(type)) continue;
      spinner.message = `fixing ${ISSUE_TITLES[type]} issues (${grouped[type].length})...`;

      const groupLength = grouped[type].length;
      let issueCount = 0;
      for (let i = 0; issueCount < groupLength; i++, issueCount++) {
        const issue = grouped[type][i];
        totalPlaces += issue.stack.length;

        const fixStrings = getFixedString(issue);
        if (fixStrings == null) {
          spinner.message = `(${issueCount}/${groupLength}) skipped: no fix available`;
          continue;
        }

        const stackLength = grouped[type][i].stack.length;
        const fixedPlaces = new Set<string>();

        if (grouped[type][i].stack.length != 0) {
          spinner.message = `(${issueCount}/${groupLength}) fixing...`;
        }

        // Fix all occurrences
        for (let j = 0, stackCount = 1; stackCount <= stackLength; stackCount++, j++) {
          const stack = grouped[type][i].stack[j];
          if (stack.filepath.startsWith("ref/")) continue; // do not fix /ref stuff, just report it.
          fixedPlaces.add(stack.filepath);
          const content = await Deno.readTextFile(stack.filepath);
          await Deno.writeTextFile(stack.filepath, content.replaceAll(fixStrings[0], fixStrings[1]));
          grouped[type][i].stack.splice(j, 1), j--;
          spinner.message = `(${issueCount}/${groupLength}): ${stack.filepath}`;
          fixesMadeThisRound++;
        }

        // All occurrences were fixed, no use keeping the issue in accounts now.
        if (grouped[type][i].stack.length == 0) {
          grouped[type].splice(i--, 1);
          spinner.message = `(${issueCount}/${groupLength}) fixed`;
        }

        // Update all issues with same references
        spinner.message = "updating references...";
        for (const type of getIssueTypes()) {
          for (const issue of grouped[type]) {
            if (!isFixableIssueType(issue.type)) break;
            // Only update the reference if all the files have been updated:
            if (issue.stack.some(({ filepath }) => !fixedPlaces.has(filepath))) continue;
            switch (issue.type) {
              case "redirected":
                issue.from = issue.from.replace(fixStrings[0], fixStrings[1]);
                break;
              case "empty_anchor":
              case "missing_anchor":
              case "disallow_extension":
              case "wrong_extension":
                issue.reference = issue.reference.replace(fixStrings[0], fixStrings[1]);
                break;
            }
          }
        }
      }

      if (groupLength - grouped[type].length > 0) {
        spinner.stop();
        console.log(green("fixed"), `${groupLength - grouped[type].length} of ${groupLength} ${ISSUE_TITLES[type]} issues`);
        spinner.start();
      }

      // No issues left in this group
      if (grouped[type].length == 0) delete grouped[type];

      fixed += fixesMadeThisRound;
    }
  } while (fixesMadeThisRound != 0);

  spinner.stop();
  console.log(green("done"), `resolved ${initial - getTotal()} issues completely and fixed problems in ${fixed} places.`);
}

for (const type of getIssueTypes()) {
  const title = ISSUE_TITLES[type];

  console.log("\n" + bold(title) + " (" + grouped[type].length + ")");
  console.log(ISSUE_DESCRIPTIONS[type]);

  for (const issue of grouped[type]) {
    console.log("\n" + indentText(makePrettyDetails(issue), 1));
    console.log("\n" + indentText(generateStackTrace(issue.stack), 4));
  }
  console.log();
}

const current = getTotal();
if (current == 0) Deno.exit(0);

console.log(`Checking completed and found ${bold(getTotal().toString())} issues.`);
if (args.fix) console.log(`Fixed issues in ${bold(fixed.toString())} places.`);

Deno.exit(1);

function getIssues() {
  return readMarkdownFiles(rootDirectory, {
    isCleanUrl: args["clean-url"],
    indexFile: args["index-file"],
    allowHtmlExtension: args["allow-ext-html"],
  });
}

function makePrettyDetails(issue: Issue) {
  if ("reference" in issue) issue.reference = decodeURI(issue.reference);
  if ("to" in issue) issue.to = decodeURI(issue.to), issue.from = decodeURI(issue.from);

  switch (issue.type) {
    case "unknown_link_format":
      return `${underline(red(issue.reference))}`;
    case "empty_dom":
      return `${underline(red(issue.reference))}`;
    case "not_ok_response":
      return `[${red(issue.status.toString())}] ${underline(issue.reference)}`; // TODO: show issue.statusText
    case "wrong_extension": {
      const { root, anchor } = parseLink(issue.reference);
      return `${root.slice(0, -extname(root).length)}\
${bold(`${strikethrough(red(issue.actual))}${green(issue.expected)}`)}\
${anchor ? dim("#" + anchor) : ""}`;
    }
    case "linked_file_not_found":
      return `${dim(red(issue.reference))} (${yellow("path")}: ${issue.filepath})`;
    case "redirected":
      return `${underline(yellow(issue.from))} --> ${underline(green(issue.to))}`;
    case "missing_anchor": {
      const { root } = parseLink(issue.reference);
      const possible = getPossibleMatches(issue.anchor, issue.allAnchors);
      return `${underline(root)}${red(bold("#" + issue.anchor))}` +
        (possible.length
          ? `\n${yellow("possible fix" + (possible.length > 1 ? "es" : ""))}: ${possible.map((match) => match).join(dim(", "))}`
          : "");
    }
    case "empty_anchor":
      return `${underline(issue.reference)}${red(bold("#"))}`;
    case "no_response":
      return `${underline(issue.reference)}`;
    case "disallow_extension": {
      const { root, anchor } = parseLink(issue.reference);
      return `${root.slice(0, -extname(root).length)}\
${bold(strikethrough(red("." + issue.extension)))}${anchor ? dim("#" + anchor) : ""}`;
    }
    case "local_alt_available":
      return `${cyan(issue.reference)}\n${issue.reason}`;
    case "inaccessible":
      return `${cyan(issue.reference)}\n${issue.reason}`;
    default:
      throw new Error("Invalid type of issue! This shouldn't be happening.");
  }
}

/** Generate stacktrace for the report */
function generateStackTrace(stacktrace: Stack[]) {
  return stacktrace.map((stack) =>
    stack.locations.map((location) =>
      location.columns.map((column) =>
        `at ${cyan(resolve(stack.filepath))}:${yellow(location.line.toString())}:${yellow(column.toString())}`
      )
    ).flat()
  ).flat().join("\n");
}

/**
 * Returns original search string and replaceable string if the issue can be fixed,
 * otherwise returns undefined.
 */
function getFixedString(issue: IssueWithStack): [string, string] | undefined {
  switch (issue.type) {
    case "redirected":
      return [issue.from, issue.to];
    case "missing_anchor": {
      const { root } = parseLink(decodeURIComponent(issue.reference));
      const possible = getPossibleMatches(issue.anchor, issue.allAnchors)[0];
      return possible == null ? undefined : [issue.reference, root + "#" + possible];
    }
    case "empty_anchor":
      return [issue.reference, issue.reference.slice(0, -1)];
    case "wrong_extension": {
      const { root } = parseLink(issue.reference);
      return [root, root.slice(0, -issue.actual.length) + issue.expected];
    }
    case "disallow_extension": {
      const { root } = parseLink(issue.reference);
      return [root, root.slice(0, -(issue.extension.length + 1))];
    }
    default:
      throw new Error("Invalid fixable type");
  }
}

function isFixableIssueType(type: Issue["type"]): type is FixableIssue["type"] {
  return FIXABLE_ISSUE_TYPES.includes(type);
}
