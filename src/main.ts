import type { context as Context } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";

import * as core from "@actions/core";

type Octokit = InstanceType<typeof GitHub>;
type PullRequest = Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"][number];

const KNOWN_BOT_LOGINS = new Set(["dependabot[bot]"]);

function parseInput(name: string): string[] {
	const raw = core.getInput(name);
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function getBaseBranch(context: typeof Context): string {
	const ref = context.payload?.ref;
	if (typeof ref === "string" && ref.startsWith("refs/heads/")) {
		return ref.slice("refs/heads/".length);
	}
	const defaultBranch = context.payload?.repository?.default_branch;
	return typeof defaultBranch === "string" && defaultBranch.length > 0 ? defaultBranch : "main";
}

function isBot(pr: PullRequest): boolean {
	if (pr.user?.type === "Bot") return true;
	return pr.user?.login != null && KNOWN_BOT_LOGINS.has(pr.user.login);
}

function describe(pr: PullRequest): string {
	return `#${pr.number} ${pr.title}`;
}

function report(updated: number, failed: number, skipped = 0): void {
	core.setOutput("updated", updated);
	core.setOutput("failed", failed);
	core.setOutput("skipped", skipped);
}

interface UpdateResult {
	pr: PullRequest;
	ok: boolean;
	message?: string;
	conflicted?: boolean;
}

/**
 * The main function for the action.
 * @param client - The GitHub client instance.
 * @param context - The context instance.
 */
export default async function run(client: Octokit, context: typeof Context): Promise<void> {
	// If the ref was deleted, no pull requests need updating.
	if (context.eventName === "delete") {
		core.info("The ref was deleted; no pull requests need updating.");
		report(0, 0);
		return;
	}

	const baseBranch = getBaseBranch(context);
	const rawLimit = core.getInput("limit");
	const limit = rawLimit ? Math.max(1, Number.parseInt(rawLimit, 10)) : 100;
	const includeDrafts = core.getBooleanInput("include_drafts");
	const includeBots = core.getBooleanInput("include_bots");
	const allowLabels = parseInput("include_labels");
	const denyLabels = parseInput("exclude_labels");

	core.info(`Searching for open pull requests targeting ${baseBranch} (limit: ${limit}).`);

	const passesFilters = (pr: PullRequest): boolean => {
		if (!includeBots && isBot(pr)) {
			core.info(`Skipping ${describe(pr)}: bot pull request.`);
			return false;
		}
		if (!includeDrafts && pr.draft) {
			core.info(`Skipping ${describe(pr)}: draft.`);
			return false;
		}
		const labels = pr.labels.map((l) => l.name).filter((n): n is string => typeof n === "string");
		if (allowLabels.length > 0 && !labels.some((l) => allowLabels.includes(l))) {
			core.info(`Skipping ${describe(pr)}: missing required label (${allowLabels.join(", ")}).`);
			return false;
		}
		if (denyLabels.length > 0 && labels.some((l) => denyLabels.includes(l))) {
			core.info(`Skipping ${describe(pr)}: has excluded label (${denyLabels.join(", ")}).`);
			return false;
		}
		return true;
	};

	const toUpdate: PullRequest[] = [];
	const iterator = client.paginate.iterator(client.rest.pulls.list, {
		...context.repo,
		base: baseBranch,
		sort: "updated",
		direction: "desc",
		state: "open",
		per_page: 100,
	});
	outer: for await (const { data: page } of iterator) {
		for (const pr of page) {
			if (passesFilters(pr)) toUpdate.push(pr);
			if (toUpdate.length >= limit) break outer;
		}
	}

	if (toUpdate.length === 0) {
		core.info("No pull requests matched the configured filters.");
		report(0, 0);
		return;
	}

	core.info(`Updating ${toUpdate.length} pull request${toUpdate.length === 1 ? "" : "s"}.`);

	const results: UpdateResult[] = await Promise.all(
		toUpdate.map(async (pr): Promise<UpdateResult> => {
			try {
				const response = await client.rest.pulls.updateBranch({
					...context.repo,
					pull_number: pr.number,
					expected_head_sha: pr.head.sha,
				});
				// updateBranch returns 202 Accepted on success.
				const ok = response.status === 202;
				return { pr, ok, message: response.data?.message };
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				return { pr, ok: false, message };
			}
		}),
	);

	results.sort((a, b) => a.pr.number - b.pr.number);

	// A pull request whose head conflicts with the base cannot be updated by any
	// caller: update-branch performs a merge, and a conflicted merge has no
	// non-interactive resolution. That is a fact about the pull request — already
	// shown on it as a conflict banner — not a failure of this action, so it is
	// counted separately rather than failing the run. The distinction bites when a
	// conflicted pull request is the ONLY candidate: counting it as a failure
	// turns "nothing was updatable" into a red run, and a permanently stale branch
	// then keeps the run red forever, burying the breakage only this action can
	// report (bad token, rate limit, 5xx).
	//
	// Only failures are re-queried — `mergeable_state` is absent from the list
	// response — so the cost is bounded by the failure count, not the PR count. A
	// lookup that itself fails leaves the result classified as a failure: unknown
	// stays loud.
	await Promise.all(
		results
			.filter((r) => !r.ok)
			.map(async (r) => {
				try {
					const { data } = await client.rest.pulls.get({ ...context.repo, pull_number: r.pr.number });
					r.conflicted = data.mergeable_state === "dirty";
				} catch {
					r.conflicted = false;
				}
			}),
	);

	const passed = results.filter((r) => r.ok);
	const conflicted = results.filter((r) => !r.ok && r.conflicted);
	const failed = results.filter((r) => !r.ok && !r.conflicted);

	for (const r of results) {
		const status = r.ok ? "✅" : r.conflicted ? "⏭️" : "❌";
		const detail = r.message ? ` — ${r.message}` : "";
		const suffix = r.conflicted ? " (conflicted; resolve on the pull request)" : "";
		core.info(`${status} ${describe(r.pr)}${detail}${suffix}`);
	}
	core.info(`Summary: ${passed.length} succeeded, ${conflicted.length} skipped as conflicted, ${failed.length} failed.`);

	if (process.env.GITHUB_STEP_SUMMARY) {
		await core.summary
			.addHeading("Auto-update pull requests", 2)
			.addRaw(`Attempted ${results.length} update${results.length === 1 ? "" : "s"} against \`${baseBranch}\`.`)
			.addList(
				results.map((r) => {
					const status = r.ok ? "✅" : r.conflicted ? "⏭️" : "❌";
					const detail = r.message ? ` — ${r.message}` : "";
					return `${status} #${r.pr.number} ${r.pr.title}${detail}`;
				}),
			)
			.addRaw(`\n**${passed.length}** succeeded · **${conflicted.length}** skipped as conflicted · **${failed.length}** failed`)
			.write();
	}

	report(passed.length, failed.length, conflicted.length);

	if (failed.length > 0 && passed.length === 0) {
		core.setFailed(`All ${failed.length} pull request updates failed.`);
	}
}
