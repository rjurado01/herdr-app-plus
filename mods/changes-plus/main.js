// Modified from munza/herdr-mods: adds review comments, context controls and syntax highlighting.
// Sidebar status/commit controls and a reusable diff-tab view share this class.
// Pure Git-output parsing and diff-row transformations live in model.js.
import { em, codeFont } from "./typography.js";
import { loadSettings, duration } from "./settings.js";
import { changedFiles, fileTree, diffRows, splitDiffRows, parseLog, commitFiles, timeAgo, githubRepo } from "./model.js";
import { highlightDiff } from "./syntax.js";
import { DiffScroll } from "./diff-scroll.js";
import { columnOffset, orderedRange, selectedOffsets, selectedText, wordRange } from "./text-selection.js";
import { commentReference } from "./comment-reference.js";
import { parseEditorCommand, editorCommand } from "./editor-command.js";
import { changeShortcut, currentShortcut } from "./shortcut.js";
import { filterFiles } from "./file-filter.js";
import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  TextView,
  Popover,
} from "gpui-base";
import {
  spaces,
  panes,
  agents,
  focused,
  exec,
  appHome,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  props,
  shared,
  setShared,
  run,
  layout,
  nextCommand,
  checking,
} from "herdr";

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

// Status polling must not take optional index locks or trigger filesystem-monitor
// helpers. Diff reads also disable external diff/textconv helpers at the call site.
const READ_ONLY_GIT_OPTIONS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];
const MAX_FILES = 1000;
const MAX_DIFF_LINES = 1500;
const MAX_LINE_LENGTH = 4000;
const CONTEXT_POLL_MS = 300;
const STATUS_POLL_MS = 10000;
const TAB_OPEN_TIMEOUT_MS = 1500;
const COMMIT_PAGE = 50;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  refresh: { status: "10s" },
  limits: { files: 1000, diff_lines: 1500, line_length: 4000, commits_per_page: 50 },
  default: { view: "tree", diff: "inline" },
  editor: { type: "nvim", command: '["code", "--goto", "{archivo}:{linea}"]' },
};
const LOG_FORMAT = "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e";

// Follow the active terminal unless the active tab is our diff viewer. Mod panes
// have no terminal cwd, so that case must use the repository saved for the tab.
function location() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((t) => t.active)?.id;
  const candidates = panes().filter((p) => p.tab === tab && p.cwd);
  if (!candidates.length && panes().some((p) => p.tab === tab && p.mod === "changes-plus")) {
    const source = (shared("changes-plus.diff-tabs") ?? {})[space?.id]?.source;
    if (source) return source;
  }
  return {
    cwd:
      candidates.find((p) => p.focused)?.cwd ??
      candidates[0]?.cwd ??
      focused()?.cwd ??
      space?.folder,
    on: space?.machine ?? null,
  };
}

// One View class serves two roles: a sidebar and a regular diff tab. Each copy
// owns its local state; shared("changes-plus.*") connects the separate copies.
export default class Changes extends View {
  // ── Lifecycle and cross-view synchronization ──────────────────────────────

  init(_props, cx) {
    this.mode = props()?.mode ?? _props?.mode ?? "sidebar";
    if (this.mode === "controller") {
      if (!checking()) this.listenForToggle(cx);
      return;
    }
    this.diffSpace = props()?.space ?? _props?.space;
    this.source = props()?.source ?? _props?.source;
    this.restoreDiffSelection(_props);
    this.settings = DEFAULT_SETTINGS;
    this.view = localStorage.getItem("changes-plus.view") === "flat" ? "flat" : "tree";
    // Optional Better Tabs integration: an icon for the diff tab.
    setShared("mod-icons", {
      ...(shared("mod-icons") ?? {}),
      "changes-plus": "mods/changes-plus/file.svg",
    });
    this.tab = ["commits", "comments"].includes(localStorage.getItem("changes-plus.tab")) ? localStorage.getItem("changes-plus.tab") : "changes";
    this.prToken = 0;
    this.prLoading = false;
    this.pr = null;
    this.prThreads = [];
    this.prError = null;
    this.prActionBusy = false;
    this.prActionError = null;
    this.resetCommits();
    this.diffLayout =
      shared("changes-plus.diff-layout") ??
      (localStorage.getItem("changes-plus.diff-layout") === "split" ? "split" : "inline");
    if (this.mode === "sidebar" || !shared("changes-plus.diff-layout"))
      setShared("changes-plus.diff-layout", this.diffLayout);
    // Local display state. Collapsed folders use "scope:path" keys so staged
    // and unstaged groups can collapse the same directory independently.
    this.splitOffset = 0;
    this.closed = new Set();
    this.files = [];
    this.rows = [];
    this.diffContext = 3;
    this.diffToken = 0; // Monotonically increasing ID for async preview requests.
    this.message = "";
    this.messageRevision = 0;
    this.commitMode = "commit";
    this.commitMenuOpen = false;
    this.commitMenuIndex = 0;
    this.commitTriggerFocus = cx.focus_handle();
    this.commitMenuFocus = cx.focus_handle();
    this.amendToken = 0;
    this.amendLoading = false;
    this.amendHead = null;
    this.input = TextareaState.new({ placeholder: "Commit message…", rows: 4 });
    this.fileFilter = TextareaState.new({ placeholder: "Filter files…", rows: 1 });
    this.fileFilter.on("change", (_e, cx) => cx.notify());
    this.commentInput = TextareaState.new({ placeholder: "Comentario para OpenCode…", rows: 3 });
    this.commentInput.set_auto_grow(3, 40);
    this.commentInputHeight = 64;
    this.commentInput.on("change", (_e, cx) => cx.notify());
    this.commentInput.on("submit", (event, cx) => {
      if (!event?.shift && !event?.secondary) {
        this.sendComment(cx);
      }
    });
    this.diffFocus = cx.focus_handle();
    this.commentOpen = false;
    this.commentSelection = null;
    this.diffScroll = new DiffScroll();
    this.textSelection = null;
    this.textDragging = false;
    this.commentTarget = null;
    this.commentBusy = false;
    this.commentNotice = null;
    this.editorBusy = false;
    this.editorNotice = null;
    this.editorChoices = null;
    this.settingsOpen = false;
    this.settingsBusy = false;
    this.settingsNotice = null;
    this.editorCommandInput = TextareaState.new({ placeholder: '["code", "--goto", "{archivo}:{linea}"]', rows: 3 });
    this.editorCommandInput.on("change", (_e, cx) => cx.notify());
    this.shortcutInput = TextareaState.new({ placeholder: "alt-g", rows: 1 });
    this.shortcutInput.on("change", (_e, cx) => cx.notify());
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      this.messageRevision++;
      cx.notify();
    });
    // Enter belongs to the multiline editor. Only the explicit button commits.
    this.startPolling(cx);
    this.listenForCommands(cx);
    this.refresh(cx);
  }

  listenForToggle(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command !== "toggle") continue;
        const options = props() ?? {};
        const panel = findLayoutNode(layout(), options.panel ?? "panel");
        const stack = findLayoutNode(layout(), options.stack ?? "panel-body");
        const child = options.child ?? "changes";
        if (!panel || !stack?.children?.some(node => node.id === child)) continue;
        if (!panel.hidden && stack.active === child) {
          run("layout.hide", { id: panel.id });
        } else {
          run("layout.select", { stack: stack.id, child });
          run("layout.show", { id: panel.id });
        }
      }
    });
  }

  // A reopened diff tab can restore its selection from local storage. Never
  // replace an existing shared entry: it may contain a more recent file pick.
  restoreDiffSelection(_props) {
    if (this.mode === "diff" && this.diffSpace) {
      const entries = shared("changes-plus.diff-tabs") ?? {};
      if (!entries[this.diffSpace]) {
        let selected = props()?.selection ?? _props?.selection;
        let source = this.source;
        try {
          const saved = JSON.parse(localStorage.getItem("diff.selection"));
          if (typeof saved?.path === "string" && typeof JSON.parse(saved.context)?.cwd === "string")
            selected = saved;
        } catch {
          // Missing or malformed saved state is harmless; use the supplied props.
        }
        try {
          if (selected) source = JSON.parse(selected.context);
        } catch {
          selected = null;
        }
        setShared("changes-plus.diff-tabs", {
          ...entries,
          [this.diffSpace]: { source, selection: selected },
        });
      }
    }
  }

  // Context changes need a quick response; full Git status reads are slower.
  // Remote repositories rely on polling because watchFolder is local-only.
  startPolling(cx) {
    cx.timer.every(CONTEXT_POLL_MS, (cx) => {
      const style = shared("changes-plus.diff-layout");
      if (style && style !== this.diffLayout) {
        this.diffLayout = style;
        localStorage.setItem("changes-plus.diff-layout", style);
        cx.notify();
      }
      if (this.contextKey() !== this.context) this.refresh(cx);
      if (this.mode === "diff") this.syncSelection(cx);
      const reload = shared("changes-plus.reload");
      if (
        reload &&
        reload.at !== this.reload &&
        reload.root === this.root &&
        reload.on === (this.on ?? null) &&
        !this.loading &&
        !this.busy
      ) {
        this.reload = reload.at;
        this.refresh(cx);
      }
    });
    this.applySettings(cx);
  }

  listenForCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "diff-inline" || command === "diff-split")
          this.setDiffLayout(command.slice(5), cx);
        if (command.startsWith("open:")) {
          const file = this.files.find((f) => f.path === command.slice(5));
          if (file) this.pick(file, cx);
        }
      }
    });
  }

  // ── Repository context and status ─────────────────────────────────────────

  location() {
    return this.mode === "diff"
      ? ((shared("changes-plus.diff-tabs") ?? {})[this.diffSpace]?.source ??
          this.source ??
          location())
      : (this.source ?? location());
  }

  // Include both cwd and machine: identical paths on different machines are
  // different repositories. Async reads compare this key before publishing.
  contextKey() {
    return JSON.stringify(this.location());
  }

  currentSelection() {
    return this.mode === "diff"
      ? ((shared("changes-plus.diff-tabs") ?? {})[this.diffSpace]?.selection ??
          shared("changes-plus.selection"))
      : shared("changes-plus.selection");
  }

  diffTab(space = this.diffSpace) {
    const target = spaces().find((s) => s.id === space);
    const ids = new Set((target?.tabs ?? []).map((t) => t.id));
    return panes().find((p) => p.mod === "changes-plus" && ids.has(p.tab))?.tab;
  }

  git(args, root = this.root, on = this.on) {
    return exec("git", [...READ_ONLY_GIT_OPTIONS, ...args], { cwd: root, on });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = this.location();
    const context = this.contextKey();
    // Clear every repository-specific field before loading the new context.
    // Incrementing diffToken invalidates previews still in flight.
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.committed = null;
      this.path = null;
      this.rows = [];
      this.closed = new Set();
      this.diffToken++;
      this.selection = null;
      this.diffLoading = false;
      this.error = null;
      this.note = null;
      this.watched = null;
      this.message = "";
      this.input.set_value("");
      this.commitMode = "commit";
      this.commitMenuOpen = false;
      this.amendToken++;
      this.amendLoading = false;
      this.amendHead = null;
      this.resetCommits();
      this.prToken++;
      this.pr = null; this.prThreads = []; this.prError = null; this.prLoading = false;
      this.prActionBusy = false; this.prActionError = null;
      this.repo = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const top = await this.git(["rev-parse", "--show-toplevel"], cwd, on);
        if (context !== this.contextKey()) return;
        if (top.code !== 0) {
          this.root = null;
          this.files = [];
          this.rows = [];
          this.error = "Not a Git repository";
          return;
        }
        const root = top.stdout.trim();
        const git = (args) => this.git(args, root, on);
        const status = await git([
          "status",
          "--porcelain=v1",
          "-z",
          "--no-renames",
          "--untracked-files=all",
        ]);
        if (status.code !== 0) throw Error(status.stderr || "Cannot read changes");
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const hasHead = head.code === 0;
        const statArgs = ["--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"];
        const stats = [
          await git(["diff", "--cached", ...statArgs]),
          await git(["diff", ...statArgs]),
        ];
        for (const stat of stats)
          if (stat.code !== 0) throw Error(stat.stderr || "Cannot read change statistics");
        // Only the sidebar links commits to GitHub; a missing or foreign remote is fine.
        const origin = this.mode === "sidebar" ? await git(["remote", "get-url", "origin"]) : null;
        if (context !== this.contextKey()) return;
        this.repo = origin?.code === 0 ? githubRepo(origin.stdout) : null;
        const files = changedFiles(
          status.stdout,
          stats.map((r) => r.stdout),
        );
        this.root = root;
        this.on = on;
        this.hasHead = hasHead;
        this.total = files.length;
        this.stagedCount = files.filter((f) => f.staged).length;
        this.unstagedCount = files.filter((f) => f.unstaged).length;
        this.conflicts = files.some((f) => f.conflict);
        this.files = files.slice(0, this.settings.limits.files || MAX_FILES);
        this.error = null;
        if (this.mode === "sidebar") {
          const committed = await this.readCommitted(git);
          if (context !== this.contextKey()) return;
          this.committed = committed;
        }
        this.watch(root, cx);
        if (this.mode === "sidebar" && this.tab === "commits") this.loadCommits(cx);
        if (this.mode === "sidebar" && this.tab === "comments" && !this.pr && !this.prLoading && !this.prError) this.loadPullRequest(cx);
        if (this.mode === "diff") {
          this.syncSelection(cx);
          if (this.path && !this.diffLoading) this.loadDiff(cx);
        }
      } catch (error) {
        if (context === this.contextKey()) this.error = error.message;
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        if (this.watched === root) this.watched = null;
      }
    });
  }
  // ── Files committed on this branch ────────────────────────────────────────

  // What this branch adds over the remote's default branch, or over its upstream
  // when the clone never recorded a default. On the default branch itself that
  // is what is not pushed yet. Null when there is nothing to compare with. These
  // read the last fetch and never fetch.
  async readCommitted(git) {
    try {
      const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      const tracked = upstream.code === 0 ? upstream.stdout.trim() : null;
      const remote = tracked?.split("/")[0] ?? "origin";
      const fallback = tracked ? { ref: "@{u}", name: tracked } : null;
      const remoteHead = await git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
      const against =
        remoteHead.code === 0 && remoteHead.stdout.trim()
          ? { ref: `refs/remotes/${remote}/HEAD`, name: remoteHead.stdout.trim() }
          : fallback;
      if (!against) return null;
      const base = await git(["merge-base", "HEAD", against.ref]);
      const head = await git(["rev-parse", "--verify", "HEAD"]);
      if (base.code !== 0 || head.code !== 0) return null;
      const from = base.stdout.trim();
      const key = `${from}:${head.stdout.trim()}`;
      // Polled with the status, and only a new commit or fetch can change it.
      if (this.committed?.key === key) return this.committed;
      const diff = (flag) =>
        git(["diff", "--no-renames", "--no-ext-diff", "--no-textconv", flag, "-z", from, "HEAD"]);
      const numstat = await diff("--numstat");
      const names = await diff("--name-status");
      if (numstat.code !== 0 || names.code !== 0) return null;
      const files = commitFiles(numstat.stdout, names.stdout);
      return {
        key,
        base: from,
        name: against.name,
        total: files.length,
        files: files.slice(0, this.settings.limits.files || MAX_FILES),
      };
    } catch {
      return null;
    }
  }

  // ── File selection and reusable diff tabs ─────────────────────────────────

  pick(file, cx, scope = "all") {
    const space = spaces().find((s) => s.active);
    if (!space) return;
    const selected = {
      context: this.context,
      root: this.root,
      on: this.on,
      path: file.path,
      scope,
      at: Date.now(),
    };
    if (scope === "commit") {
      // The diff tab has no commit list, so the pick carries what it needs.
      const { hash, short, subject } = this.selectedCommit;
      selected.commit = { hash, short, subject };
      selected.file = file;
    }
    if (scope === "committed") {
      selected.commit = { base: this.committed.base, name: this.committed.name };
      selected.file = file;
    }
    if (scope === "pr") {
      if (!this.pr?.baseRefOid || !this.pr?.headRefOid) return;
      selected.commit = { base: this.pr.baseRefOid, hash: this.pr.headRefOid, name: `PR #${this.pr.number}` };
      selected.prThreads = this.prThreads.filter(thread => thread.path === file.path && !thread.isResolved && !thread.isOutdated && thread.line && ["LEFT", "RIGHT"].includes(thread.diffSide))
        .map(thread => ({ id: thread.id, line: thread.line, side: thread.diffSide, comments: (thread.comments?.nodes ?? []).map(comment => { const body = String(comment.body ?? ""); return { author: comment.author?.login ?? "usuario eliminado", body: body.length > 20000 ? body.slice(0, 20000) + "\n\n[Comentario truncado; consulta PR Comments.]" : body }; }) }));
      selected.file = file;
    }
    const entries = shared("changes-plus.diff-tabs") ?? {};
    const old = entries[space.id];
    const tab = this.diffTab(space.id);
    const source = JSON.parse(this.context);
    const name = file.path.split("/").pop();
    // Publish before opening/selecting the tab so its View sees the latest pick.
    // A pending timestamp prevents rapid clicks from creating duplicate tabs.
    setShared("changes-plus.selection", selected);
    setShared("changes-plus.diff-tabs", {
      ...entries,
      [space.id]: {
        source,
        selection: selected,
        pending: tab ? null : (old?.pending ?? Date.now()),
      },
    });
    if (tab) {
      run("tab.rename", { id: tab, name });
      run("tab.select", { id: tab });
    } else if (!old?.pending || Date.now() - old.pending > TAB_OPEN_TIMEOUT_MS) {
      run("tab.new", {
        space: space.id,
        name,
        mod: "changes-plus",
        props: { mode: "diff", space: space.id, source, selection: selected },
      });
    }
    // Layouts with an optional center stack (such as Factory) need their tab view
    // revealed. Ordinary Herdr layouts already show the selected tab directly.
    const find = (node) =>
      node?.id === "center-body" ? node : (node?.children ?? []).map(find).find(Boolean);
    const center = find(layout());
    if (center?.type === "stack" && center.children?.some((child) => child.id === "main"))
      run("layout.select", { stack: center.id, child: "main" });
    cx.notify();
  }

  syncSelection(cx) {
    const selected = this.currentSelection();
    if (!selected || selected.context !== this.context) {
      if (this.path) {
        this.path = null;
        this.rows = [];
        this.diffToken++;
        this.diffLoading = false;
        cx.notify();
      }
      return;
    }
    const id = JSON.stringify(selected);
    if (id === this.selection) return;
    localStorage.setItem("diff.selection", JSON.stringify(selected));
    const tab = this.diffTab();
    if (tab) {
      const name = selected.path.split("/").pop();
      const live = spaces()
        .find((s) => s.id === this.diffSpace)
        ?.tabs?.find((t) => t.id === tab);
      if (live?.name !== name) run("tab.rename", { id: tab, name });
      const entries = shared("changes-plus.diff-tabs") ?? {};
      if (entries[this.diffSpace]?.pending) {
        // Only a newly opened diff goes last; reused tabs keep their position.
        const space = spaces().find((s) => s.id === this.diffSpace);
        if (space) run("tab.move", { id: tab, index: space.tabs.length });
        setShared("changes-plus.diff-tabs", {
          ...entries,
          [this.diffSpace]: { ...entries[this.diffSpace], pending: null },
        });
      }
    }
    this.splitOffset = 0;
    this.diffScroll.top = 0;
    this.textSelection = null;
    this.textDragging = false;
    this.commentOpen = false;
    this.selection = id;
    this.path = selected.path;
    this.scope = selected.scope || "all";
    this.commitRef = selected.commit ?? null;
    this.commitFile = selected.file ?? null;
    this.diffPrThreads = selected.scope === "pr" ? (selected.prThreads ?? []) : [];
    this.openPrThread = null;
    this.rows = [];
    this.note = null;
    this.diffToken++;
    this.diffLoading = false;
    if (this.root) this.loadDiff(cx);
    cx.notify();
    // A fresh file pick should make the diff's shortcuts available immediately.
    // Wait for its view to mount, and never pull focus back from a terminal.
    if (tab && Number.isFinite(selected.at) && Date.now() - selected.at < 1500) {
      cx.spawn(async cx => {
        await cx.sleep(50);
        const active = focused();
        if (this.selection === id && !this.commentOpen && active?.tab === tab && !active.terminal)
          this.diffFocus.focus();
      });
    }
  }
  // ── Read-only diff loading ────────────────────────────────────────────────

  loadDiff(cx) {
    const path = this.path;
    const context = this.context;
    const root = this.root;
    const on = this.on;
    const hasHead = this.hasHead;
    const scope = this.scope || "all";
    const commit = this.commitRef;
    const file =
      scope === "commit" || scope === "committed" || scope === "pr"
        ? this.commitFile
        : this.files.find((f) => f.path === path);
    const token = ++this.diffToken;
    this.note = null;
    if (!file) {
      this.rows = [];
      this.note = `This file has no remaining changes, or is outside the first ${(this.settings.limits.files || MAX_FILES).toLocaleString()} listed files.`;
      this.diffLoading = false;
      cx.notify();
      return;
    }
    if ((scope === "staged" && !file.staged) || (scope === "unstaged" && !file.unstaged)) {
      this.rows = [];
      this.note = `No ${scope} changes remain for this file.`;
      this.diffLoading = false;
      cx.notify();
      return;
    }
    this.diffLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let lines;
        // Untracked files (and all-changes previews before the first commit)
        // have no HEAD version to diff against. Build an all-additions hunk.
        if (file.fresh || (!hasHead && file.status === "A" && scope === "all")) {
          const text = await readTextFile(`${root}/${path}`, { on });
          if (text === null)
            lines = ["Cannot preview this file: binary, too large, or unreadable."];
          else if (text.includes("\0")) lines = ["Binary file · no text diff"];
          else if (!text) lines = ["Empty new file"];
          else {
            const all = text.replace(/\n$/, "").split("\n");
            file.add = all.length;
            lines = [`@@ -0,0 +1,${all.length} @@`, ...all.map((line) => `+${line}`)];
          }
        } else {
          // `--` separates paths from options, but still allows Git patterns.
          // Treat the selected filename literally, just like index mutations.
          const result = await this.git(
            [
              "--literal-pathspecs",
              ...(scope === "commit"
                ? ["show", "--diff-merges=first-parent", "--format=", commit.hash]
                : scope === "pr"
                  ? ["diff", `${commit.base}...${commit.hash}`]
                : scope === "committed"
                  ? ["diff", commit.base, "HEAD"]
                  : [
                    "diff",
                    ...(scope === "staged"
                      ? ["--cached"]
                      : scope === "unstaged"
                        ? []
                        : hasHead
                          ? ["HEAD"]
                          : []),
                  ]),
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              `--unified=${this.diffContext}`,
              "--",
              path,
            ],
            root,
            on,
          );
          if (result.code !== 0) throw Error(result.stderr || "Cannot read diff");
          const all = result.stdout.replace(/\n$/, "").split("\n");
          const first = all.findIndex((line) => line.startsWith("@@"));
          lines =
            first < 0
              ? [
                  file.binary
                    ? "Binary file changed"
                    : "No text diff available (mode-only or submodule change)",
                ]
              : all.slice(first);
        }
        // A later click or repository switch may have overtaken this request.
        if (token !== this.diffToken || context !== this.contextKey()) return;
        const maxLines = this.settings.limits.diff_lines || MAX_DIFF_LINES;
        const maxLength = this.settings.limits.line_length || MAX_LINE_LENGTH;
        this.truncated =
          lines.length > maxLines || lines.some((line) => line.length > maxLength);
        const visible = lines
          .slice(0, maxLines)
          .map((line) =>
            line.length > maxLength ? line.slice(0, maxLength) + "…" : line,
          );
        this.rows = diffRows(visible);
        this.syntaxTokens = highlightDiff(this.rows.map(row => ({ ...row, new: row.next })), path);
        this.width = Math.max(300, ...visible.map((line) => line.length * em(0.7) + 110));
      } catch (error) {
        if (token === this.diffToken && context === this.contextKey()) {
          this.rows = [];
          this.note = error.message;
        }
      } finally {
        if (token === this.diffToken) {
          this.diffLoading = false;
          cx.notify();
        }
      }
    });
  }
  // Read the installed mod.json once, then start the status poll at its pace.
  // The view and diff defaults apply only where nothing was chosen before.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("changes-plus", DEFAULT_SETTINGS);
      this.settings = settings;
      for (const problem of problems) console.warn(`changes-plus mod.json settings: ${problem}`);
      if (localStorage.getItem("changes-plus.view") === null && ["tree", "flat"].includes(settings.default.view))
        this.view = settings.default.view;
      if (
        this.mode === "sidebar" &&
        localStorage.getItem("changes-plus.diff-layout") === null &&
        ["inline", "split"].includes(settings.default.diff)
      ) {
        this.diffLayout = settings.default.diff;
        setShared("changes-plus.diff-layout", this.diffLayout);
      }
      // A floor, so a bare number read as milliseconds cannot spin Git.
      const every = Math.max(1000, duration(settings.refresh.status, STATUS_POLL_MS));
      cx.timer.every(every, (cx) => this.refresh(cx));
      cx.notify();
    });
  }

  // ── Git mutations (sidebar only) ──────────────────────────────────────────

  // Never reset working files. Unstage changes only the index; before the first
  // commit there is no HEAD, so remove index entries with git rm --cached.
  // Literal pathspecs keep names such as [sample].txt from acting as patterns.
  indexAction(action, path, cx) {
    if (
      !this.root ||
      this.loading ||
      this.busy ||
      this.contextKey() !== this.context ||
      this.mode !== "sidebar"
    )
      return;
    if (
      path &&
      !this.files.some((f) => f.path === path && (action === "stage" ? f.unstaged : f.staged))
    )
      return;
    const root = this.root;
    const on = this.on;
    const context = this.context;
    const query = this.fileFilter.value();
    const paths = !path && query
      ? filterFiles(this.files, query).filter((f) => action === "stage" ? f.unstaged : f.staged).map((f) => f.path)
      : null;
    if (paths && !paths.length) return;
    let args;
    if (action === "stage")
      args = paths ? ["--literal-pathspecs", "add", "--", ...paths] : path ? ["--literal-pathspecs", "add", "--", path] : ["add", "-A"];
    else if (action === "unstage")
      args = this.hasHead
        ? ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...(paths || [path || "."])]
        : ["--literal-pathspecs", "rm", "--cached", "-r", "-f", "--", ...(paths || [path || "."])];
    else return;
    this.busy = true;
    this.operation = action;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.git(args, root, on);
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const at = Date.now();
        this.reload = at;
        setShared("changes-plus.reload", { root, on: on ?? null, at });
      } catch (error) {
        if (context === this.contextKey())
          this.note = `${action === "stage" ? "Stage" : "Unstage"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.operation = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  setCommitMode(mode, cx) {
    if (
      !["commit", "amend"].includes(mode) ||
      !this.root ||
      this.loading ||
      this.busy ||
      this.contextKey() !== this.context ||
      this.mode !== "sidebar" ||
      (mode === "amend" && !this.hasHead)
    )
      return;

    this.commitMode = mode;
    this.commitMenuOpen = false;
    this.note = null;
    this.amendHead = null;
    const token = ++this.amendToken;
    this.amendLoading = mode === "amend";
    cx.notify();
    if (mode !== "amend") return;

    const context = this.context;
    const root = this.root;
    const on = this.on;
    const revision = this.messageRevision;
    cx.spawn(async (cx) => {
      try {
        // Read the commit ID and full message together. Never replace a draft
        // the user already wrote, or one edited while this read was in flight.
        const result = await this.git(["log", "-1", "--format=%H%x00%B"], root, on);
        if (token !== this.amendToken || context !== this.contextKey()) return;
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const separator = result.stdout.indexOf("\0");
        const head = result.stdout.slice(0, separator);
        if (separator < 0 || !/^[0-9a-f]{40,64}$/i.test(head))
          throw Error("Cannot read the latest commit.");
        this.amendHead = head;
        if (!this.message.trim() && this.messageRevision === revision) {
          this.message = result.stdout.slice(separator + 1).trimEnd();
          this.input.set_value(this.message);
        }
      } catch (error) {
        if (token === this.amendToken && context === this.contextKey())
          this.note = `Cannot prepare amend: ${error.message}`;
      } finally {
        if (token === this.amendToken) {
          this.amendLoading = false;
          cx.notify();
        }
      }
    });
  }

  canCommit() {
    const ready =
      this.message.trim() &&
      this.root &&
      !this.busy &&
      !this.loading &&
      !this.conflicts &&
      this.mode === "sidebar" &&
      this.contextKey() === this.context;
    // A message-only amend is valid; a new commit still needs staged changes.
    return Boolean(
      ready &&
      (this.commitMode === "amend"
        ? this.hasHead && this.amendHead && !this.amendLoading
        : this.stagedCount),
    );
  }

  // Both operations use the existing index, never `-a` or an implicit stage-all.
  // Preserve the draft on failure, and any new text typed during a successful write.
  commit(cx) {
    if (!this.canCommit()) return;
    const root = this.root;
    const on = this.on;
    const context = this.context;
    const originalMessage = this.message;
    const message = originalMessage.trim();
    const amend = this.commitMode === "amend";
    const expectedHead = this.amendHead;
    this.busy = true;
    this.operation = amend ? "amend" : "commit";
    this.commitMenuOpen = false;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (amend) {
          // Recheck after the human edits the message: another tool may have
          // advanced HEAD since they selected Amend. Do not rewrite it silently.
          const head = await this.git(["rev-parse", "--verify", "HEAD"], root, on);
          if (head.code !== 0 || head.stdout.trim() !== expectedHead)
            throw Error("Latest commit changed. Choose Amend again before retrying.");
        }
        const args = ["commit", ...(amend ? ["--amend"] : []), "-m", message];
        const result = await this.git(args, root, on);
        if (result.code !== 0) throw Error((result.stderr || result.stdout).trim());
        const at = Date.now();
        this.reload = at;
        setShared("changes-plus.reload", { root, on: on ?? null, at });
        if (context === this.contextKey()) {
          if (this.message === originalMessage) {
            this.message = "";
            this.input.set_value("");
          }
          this.commitMode = "commit";
          this.amendHead = null;
        }
      } catch (error) {
        if (context === this.contextKey())
          this.note = `${amend ? "Amend" : "Commit"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.operation = null;
        this.refresh(cx);
        cx.notify();
      }
    });
  }
  // ── Commit history (sidebar only) ─────────────────────────────────────────

  resetCommits() {
    this.commits = [];
    this.upstream = null;
    this.remoteHead = null;
    this.commitsDone = false;
    this.commitsLoading = false;
    this.commitsError = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFilesLoading = false;
    this.commitFilesError = null;
    // History and the open commit load independently, so each has its own token.
    this.commitsToken = (this.commitsToken ?? 0) + 1;
    this.commitToken = (this.commitToken ?? 0) + 1;
  }

  setTab(tab, cx) {
    this.tab = tab;
    localStorage.setItem("changes-plus.tab", tab);
    if (tab === "commits" && !this.commits.length) this.loadCommits(cx);
    if (tab === "comments" && !this.pr && !this.prError && !this.prLoading) this.loadPullRequest(cx);
    cx.notify();
  }

  loadPullRequest(cx) {
    if (!this.root || this.prLoading || this.prActionBusy) return;
    const token = ++this.prToken, context = this.context, root = this.root, on = this.on;
    this.prLoading = true; this.prError = null; this.pr = null; this.prThreads = [];
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("gh", ["pr", "view", "--json", "id,number,title,url,state,baseRefOid,headRefOid,headRefName"], { cwd: root, on });
        if (result.code !== 0) throw new Error((result.stderr || "No se pudo consultar el PR").trim());
        const pr = JSON.parse(result.stdout);
        if (pr.state !== "OPEN") throw new Error("La rama actual no tiene un pull request abierto.");
        const query = `query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequest { reviewThreads(first: 50, after: $endCursor) { nodes { id path line originalLine diffSide isResolved isOutdated viewerCanResolve comments(first: 50) { totalCount nodes { id author { login } body createdAt reactionGroups { content viewerHasReacted users { totalCount } } } } } pageInfo { hasNextPage endCursor } } } } }`;
        const threads = await exec("gh", ["api", "graphql", "--paginate", "--slurp", "-f", `query=${query}`, "-f", `id=${pr.id}`], { cwd: root, on });
        if (threads.code !== 0) throw new Error((threads.stderr || "No se pudieron leer los comentarios").trim());
        const pages = JSON.parse(threads.stdout);
        if (!Array.isArray(pages) || pages.some(p => p.errors || !p.data?.node?.reviewThreads)) throw new Error("GitHub devolvió una respuesta de hilos incompleta.");
        if (token !== this.prToken || context !== this.contextKey()) return;
        this.pr = pr;
        this.prThreads = pages.flatMap(p => p.data.node.reviewThreads.nodes);
      } catch (e) {
        if (token !== this.prToken || context !== this.contextKey()) return;
        const error = String(e?.message ?? e);
        this.prError = /no pull requests found|no pull request found/i.test(error) ? "La rama actual no tiene un pull request abierto." : error;
      } finally {
        if (token === this.prToken) { this.prLoading = false; cx.notify(); }
      }
    });
  }

  prAction(cx, kind, thread, comment = null) {
    if (this.prActionBusy || this.prLoading) return;
    const context = this.context, token = this.prToken, root = this.root, on = this.on;
    const reaction = comment?.reactionGroups?.find(group => group.content === "THUMBS_UP");
    const operation = kind === "resolve" ? "resolveReviewThread" : reaction?.viewerHasReacted ? "removeReaction" : "addReaction";
    const query = kind === "resolve"
      ? `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }`
      : `mutation($id: ID!) { ${operation}(input: {subjectId: $id, content: THUMBS_UP}) { subject { ... on PullRequestReviewComment { id reactionGroups { content viewerHasReacted users { totalCount } } } } } }`;
    this.prActionBusy = true; this.prActionError = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `id=${kind === "resolve" ? thread.id : comment.id}`], { cwd: root, on });
        if (result.code !== 0) throw new Error((result.stderr || "No se pudo actualizar GitHub").trim());
        const data = JSON.parse(result.stdout);
        if (data.errors?.length) throw new Error(data.errors.map(error => error.message).join("; "));
        const updated = kind === "resolve" ? data.data?.[operation]?.thread : data.data?.[operation]?.subject;
        if (!updated || updated.id !== (kind === "resolve" ? thread.id : comment.id) || (kind === "resolve" ? updated.isResolved !== true : !Array.isArray(updated.reactionGroups))) throw new Error("GitHub devolvió una respuesta incompleta.");
        if (token !== this.prToken || context !== this.contextKey()) return;
        if (kind === "resolve") thread.isResolved = true;
        else comment.reactionGroups = updated.reactionGroups;
      } catch (error) {
        if (token === this.prToken && context === this.contextKey()) this.prActionError = String(error?.message ?? error);
      } finally {
        if (token === this.prToken) { this.prActionBusy = false; cx.notify(); }
      }
    });
  }

  // Reload keeps the pages already shown; `more` appends the next page.
  // Where the branch's remote head was at the last fetch: {name, unpushed, behind},
  // or null when the branch tracks nothing. This never fetches.
  async readUpstream() {
    const name = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (name.code !== 0) return null;
    const sides = await this.git(["rev-list", "--left-right", "HEAD...@{u}"]);
    if (sides.code !== 0) return null;
    const lines = sides.stdout.split("\n");
    return {
      name: name.stdout.trim(),
      unpushed: new Set(lines.filter((l) => l[0] === "<").map((l) => l.slice(1))),
      behind: lines.filter((l) => l[0] === ">").length,
    };
  }

  // The remote's default branch, from the upstream's remote or else origin:
  // {name, target, base, behind}, with base the last commit shared with it.
  // Null when the clone never recorded one, since finding out would need the network.
  async readRemoteHead(upstream) {
    const remote = upstream?.name.split("/")[0] ?? "origin";
    const ref = `refs/remotes/${remote}/HEAD`;
    const target = await this.git(["symbolic-ref", "--short", ref]);
    if (target.code !== 0 || !target.stdout.trim()) return null;
    const base = await this.git(["merge-base", "HEAD", ref]);
    const behind = await this.git(["rev-list", "--count", `HEAD..${ref}`]);
    if (base.code !== 0 || behind.code !== 0) return null;
    return {
      name: `${remote}/HEAD`,
      target: target.stdout.trim(),
      base: base.stdout.trim(),
      behind: Number(behind.stdout) || 0,
    };
  }

  // A line in the history naming the remote refs that sit at this commit.
  remoteMarker(id, labels, t) {
    return h_flex()
      .id(id)
      .flex_none()
      .px(8)
      .py(4)
      .gap(6)
      .items_center()
      .text_size(em(0.8))
      .text_color(t.accent)
      .child(div().flex_none().child(labels.join(", ")))
      .child(div().flex_1().h(1).bg(t.accent));
  }

  loadCommits(cx, more = false) {
    if (this.commitsLoading || !this.root) return;
    if (!this.hasHead) {
      this.commits = [];
      this.commitsDone = true;
      return;
    }
    const context = this.context;
    const token = ++this.commitsToken;
    const page = this.settings.limits.commits_per_page || COMMIT_PAGE;
    const count = more ? page : Math.max(page, this.commits.length);
    const skip = more ? this.commits.length : 0;
    this.commitsLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.git([
          "log",
          "--no-color",
          LOG_FORMAT,
          "-n",
          String(count),
          "--skip",
          String(skip),
        ]);
        if (token !== this.commitsToken || context !== this.contextKey()) return;
        if (result.code !== 0) throw Error(result.stderr || "Cannot read history");
        const page = parseLog(result.stdout);
        const upstream = more ? this.upstream : await this.readUpstream();
        const remoteHead = more ? this.remoteHead : await this.readRemoteHead(upstream);
        if (token !== this.commitsToken || context !== this.contextKey()) return;
        this.upstream = upstream;
        this.remoteHead = remoteHead;
        this.commits = more ? [...this.commits, ...page] : page;
        this.commitsDone = page.length < count;
        this.commitsError = null;
      } catch (error) {
        if (token === this.commitsToken) this.commitsError = error.message;
      } finally {
        if (token === this.commitsToken) {
          this.commitsLoading = false;
          cx.notify();
        }
      }
    });
  }

  openCommit(commit, cx) {
    const context = this.context;
    const token = ++this.commitToken;
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitFilesError = null;
    this.commitFilesLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // `--numstat --name-status` together print only the last one, so ask twice.
        const show = (flag) =>
          this.git([
            "show",
            "--diff-merges=first-parent",
            "--format=",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            flag,
            "-z",
            commit.hash,
          ]);
        const numstat = await show("--numstat");
        const names = await show("--name-status");
        if (token !== this.commitToken || context !== this.contextKey()) return;
        if (numstat.code !== 0 || names.code !== 0)
          throw Error(numstat.stderr || names.stderr || "Cannot read commit");
        this.commitFiles = commitFiles(numstat.stdout, names.stdout);
      } catch (error) {
        if (token === this.commitToken) this.commitFilesError = error.message;
      } finally {
        if (token === this.commitToken) {
          this.commitFilesLoading = false;
          cx.notify();
        }
      }
    });
  }

  closeCommit(cx) {
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitToken++;
    this.commitFilesLoading = false;
    cx.notify();
  }
  // ── Shared controls and file rows ─────────────────────────────────────────

  icon(id, asset, label, action, t, active = false, disabled = false, size = 24) {
    return div()
      .id(id)
      .size(size)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      // Stage/unstage buttons keep a resting fill so they read as actions; the rest fill on hover only.
      .when(active || asset === "stage" || asset === "unstage", (el) => el.bg(t.selected))
      .text_color(disabled ? t.dim : active ? t.foreground : t.muted)
      .tooltip(label)
      .accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(!disabled, (el) =>
        el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)),
      )
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!disabled) action(cx);
      })
      .child(svg(`mods/changes-plus/${asset}.svg`).size(size <= 22 ? 12 : 14));
  }

  // One 12px slot per ancestor level, each with a faint guide line under its chevron.
  guides(depth, height, t) {
    const slots = [];
    for (let level = 0; level < depth; level++)
      slots.push(div().w(12).h(height).flex_none().child(div().w(1).h_full().ml(5).bg(t.border)));
    return slots;
  }

  fileRow(file, depth, t, scope = "all") {
    const flat = this.view === "flat";
    const parts = file.path.split("/");
    const name = parts.pop();
    const selected = this.currentSelection();
    return h_flex()
      .id(`change-${scope}-${file.path}`)
      .h(30)
      .flex_none()
      .pl(8)
      .pr(8)
      .gap(7)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .when(
        selected?.context === this.context &&
          selected?.path === file.path &&
          (selected.scope || "all") === scope,
        (el) => el.bg(t.selected),
      )
      .hover((s) => s.bg(t.hover))
      .tooltip(file.path)
      .on_click((_e, cx) => this.pick(file, cx, scope))
      .children(this.guides(depth, 30, t))
      .child(svg("mods/changes-plus/file.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(flat && parts.length > 0, (el) =>
        el.child(
          div().max_w(110).truncate().text_size(em(0.8)).text_color(t.dim).child(parts.join("/")),
        ),
      )
      .when(file.add > 0, (el) =>
        el.child(div().text_size(em(0.8)).text_color(t.ansi2).child(`+${file.add}`)),
      )
      .when(file.del > 0, (el) =>
        el.child(div().text_size(em(0.8)).text_color(t.ansi1).child(`−${file.del}`)),
      )
      .child(
        div()
          .w(13)
          .text_size(em(0.8))
          .text_color(
            file.status === "A"
              ? t.ansi2
              : file.status === "D" || file.status === "U"
                ? t.ansi1
                : t.blocked,
          )
          .child(file.status),
      )
      .when(scope === "staged" || scope === "unstaged", (el) =>
        el.child(
          this.icon(
            `changes-${scope === "staged" ? "unstage" : "stage"}-${file.path}`,
            scope === "staged" ? "unstage" : "stage",
            scope === "staged" ? "Unstage file" : "Stage file",
            (cx) => this.indexAction(scope === "staged" ? "unstage" : "stage", file.path, cx),
            t,
            false,
            this.busy || this.loading,
            20,
          ),
        ),
      );
  }

  setDiffLayout(style, cx) {
    if (!["inline", "split"].includes(style)) return;
    this.diffLayout = style;
    localStorage.setItem("changes-plus.diff-layout", style);
    setShared("changes-plus.diff-layout", style);
    cx.notify();
  }

  diffLayoutToggle(t) {
    const row = h_flex()
      .id("changes-diff-layout")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const [style, label] of [
      ["inline", "Inline diff"],
      ["split", "Side-by-side diff"],
    ]) {
      const active = this.diffLayout === style;
      row.child(
        div()
          .id(`changes-diff-${style}`)
          .size(22)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .tooltip(label)
          .accessibility_label(label)
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .on_click((_e, cx) => this.setDiffLayout(style, cx))
          .child(svg(`mods/changes-plus/diff-${style}.svg`).size(13)),
      );
    }
    return row;
  }
  // ── Sidebar rendering ────────────────────────────────────────────────────

  render() {
    if (this.mode === "controller") return div();
    const t = theme();
    const root = v_flex()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(em(1));
    if (this.mode === "diff") return this.renderDiff(root, t);
    root.child(this.renderSidebarHeader(t));
    if (this.settingsOpen) return root.child(this.renderEditorSettings(t));
    if (this.tab === "commits") {
      root.child(this.selectedCommit ? this.renderCommitDetail(t) : this.renderCommitList(t));
      return root;
    }
    if (this.tab === "comments") {
      root.child(this.renderPullRequestComments(t));
      return root;
    }
    root.child(div().px(6).pt(6).flex_none().child(
      Textarea.new(this.fileFilter).id("changes-file-filter").w_full().h(32).px(8).py(5)
        .rounded(6).border_1().border_color(t.border).bg(t.surface).text_color(t.foreground)
        .text_size(em(0.9)).accessibility_label("Filter files"),
    ));
    root.child(this.renderFileList(t));
    if (this.error && this.files.length)
      root.child(div().px(12).py(6).text_color(t.ansi1).child(this.error));
    if (this.note) root.child(div().px(12).py(6).text_color(t.ansi1).child(this.note));
    root.child(this.renderCommitFooter(t));
    return root;
  }

  renderSidebarHeader(t) {
    const head = h_flex()
      .h(44)
      .px(12)
      .gap(6)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(t.border);
    const tabs = h_flex()
      .id("changes-tabs")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const [tab, label] of [
      ["changes", "Changes"],
      ["commits", "Commits"],
      ["comments", "PR Comments"],
    ]) {
      const active = this.tab === tab;
      tabs.child(
        div()
          .id(`changes-tab-${tab}`)
          .h(22)
          .px(8)
          .flex()
          .items_center()
          .rounded(5)
          .text_size(em(0.85))
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .gap(5)
          .on_click((_e, cx) => this.setTab(tab, cx))
          .child(label)
          .when(tab === "changes", (el) =>
            el.child(div().text_size(em(0.75)).text_color(t.dim).child(String(this.total ?? 0))),
          ),
      );
    }
    head.child(tabs);
    head.child(div().flex_1());
    head.child(this.diffLayoutToggle(t));
    const fileViews = h_flex()
      .id("changes-file-view")
      .p(2)
      .gap(2)
      .items_center()
      .flex_none()
      .rounded(7)
      .border_1()
      .border_color(t.selected);
    for (const view of ["tree", "flat"]) {
      const active = this.view === view;
      const label = view === "tree" ? "Tree view" : "Flat view";
      fileViews.child(
        div()
          .id(`changes-${view}`)
          .size(22)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .when(active, (el) => el.bg(t.selected))
          .text_color(active ? t.foreground : t.muted)
          .cursor_pointer()
          .tooltip(label)
          .accessibility_label(label)
          .hover((el) => el.bg(active ? t.selected : t.hover))
          .on_click((_e, cx) => {
            this.view = view;
            localStorage.setItem("changes-plus.view", view);
            cx.notify();
          })
          .child(svg(`mods/changes-plus/${view}.svg`).size(13)),
      );
    }
    head.child(fileViews);
    head.child(
      this.icon("changes-refresh", "refresh", this.tab === "comments" ? "Refresh pull request comments" : "Refresh changes", (cx) => this.tab === "comments" ? this.loadPullRequest(cx) : this.refresh(cx), t),
    );
    head.child(this.icon("changes-settings", "settings", "Ajustes de Changes Plus", cx => this.openEditorSettings(cx), t, this.settingsOpen));
    return head;
  }

  openEditorSettings(cx) {
    if (this.settingsOpen) { this.settingsOpen = false; cx.notify(); return; }
    this.settingsOpen = true;
    this.settingsBusy = true;
    this.settingsNotice = null;
    this.shortcutSnapshot = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const raw = await readTextFile(`${appHome()}/mods/changes-plus/mod.json`);
        if (raw === null) throw new Error("No se encuentra mod.json.");
        const config = JSON.parse(raw);
        this.settingsSnapshot = raw;
        this.editorTypeDraft = config.settings?.editor?.type === "command" ? "command" : "nvim";
        this.editorCommandInput.set_value(config.settings?.editor?.command ?? DEFAULT_SETTINGS.editor.command);
        this.shortcutLayout = shared("layout");
        const keys = await readTextFile(`${appHome()}/keys.json`);
        if (!this.shortcutLayout || keys === null) throw new Error("No se encuentra el layout activo o keys.json.");
        this.shortcutSnapshot = keys;
        this.shortcutInput.set_value(currentShortcut(JSON.parse(keys), this.shortcutLayout));
      } catch (error) { this.settingsNotice = String(error?.message ?? error); this.settingsSnapshot = null; }
      finally { this.settingsBusy = false; cx.notify(); }
    });
  }

  saveEditorSettings(cx) {
    if (this.settingsBusy || !this.settingsSnapshot || !this.shortcutSnapshot) return;
    const command = this.editorCommandInput.value();
    let updatedKeys;
    try {
      if (this.editorTypeDraft === "command") parseEditorCommand(command);
      if (shared("layout") !== this.shortcutLayout) throw new Error("El layout ha cambiado. Cierra y vuelve a abrir los ajustes.");
      const keys = JSON.parse(this.shortcutSnapshot);
      const input = this.shortcutInput.value().trim();
      const previous = currentShortcut(keys, this.shortcutLayout);
      updatedKeys = input || previous ? changeShortcut(keys, this.shortcutLayout, input) : keys;
    }
    catch (error) { this.settingsNotice = String(error?.message ?? error); cx.notify(); return; }
    const expected = this.settingsSnapshot;
    const config = JSON.parse(expected);
    config.settings ??= {};
    config.settings.editor = { ...(config.settings.editor ?? {}), type: this.editorTypeDraft, command };
    const keysText = JSON.stringify(updatedKeys, null, 2) + "\n";
    const keysChanged = JSON.stringify(updatedKeys) !== JSON.stringify(JSON.parse(this.shortcutSnapshot));
    const configChanged = JSON.stringify(config) !== JSON.stringify(JSON.parse(expected));
    this.settingsBusy = true;
    this.settingsNotice = null;
    cx.notify();
    cx.spawn(async cx => {
      let keysSaved = false;
      try {
        if (keysChanged) {
          await writeTextFile(`${appHome()}/keys.json`, keysText, this.shortcutSnapshot);
          this.shortcutSnapshot = keysText;
          keysSaved = true;
        }
        if (configChanged)
          await writeTextFile(`${appHome()}/mods/changes-plus/mod.json`, JSON.stringify(config, null, 2) + "\n", expected);
        this.settingsOpen = false;
      } catch (error) {
        this.settingsNotice = `${keysSaved ? "El atajo se guardó, pero no los ajustes del editor. " : "No se pudo guardar. "}${String(error?.message ?? error)}. Cierra y vuelve a abrir los ajustes.`;
      }
      finally { this.settingsBusy = false; cx.notify(); }
    });
  }

  renderEditorSettings(t) {
    const button = (id, label, action, active = false) => div().id(id).px(10).py(6).rounded(4)
      .bg(active ? t.selected : t.raised).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(label);
    const panel = v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .child(div().font_semibold().child("Ajustes de Changes Plus"))
      .child(div().child("Editor para abrir archivos"))
      .child(h_flex().gap(6)
        .child(button("editor-setting-nvim", "Neovim", cx => { this.editorTypeDraft = "nvim"; cx.notify(); }, this.editorTypeDraft === "nvim"))
        .child(button("editor-setting-command", "Comando personalizado", cx => { this.editorTypeDraft = "command"; cx.notify(); }, this.editorTypeDraft === "command")));
    if (this.editorTypeDraft === "command") {
      panel.child(div().text_color(t.muted).whitespace_normal().child('Lista JSON: ejecutable y argumentos. Usa {archivo} y, opcionalmente, {linea}. Ejemplo: ["code", "--goto", "{archivo}:{linea}"].'));
      panel.child(Textarea.new(this.editorCommandInput).w_full().px(8).py(5).rounded(6).border_1().border_color(t.border).bg(t.surface).text_color(t.foreground));
      panel.child(div().text_color(t.dim).whitespace_normal().child("Se ejecuta sin shell en este equipo; no admite archivos de máquinas remotas."));
    }
    panel.child(div().font_semibold().child("Atajo para mostrar u ocultar Changes"));
    panel.child(div().text_color(t.muted).whitespace_normal().child(
      `Solo para el layout ${this.shortcutLayout ?? "actual"}. Usa, por ejemplo, alt-g o ctrl-shift-f8. No se sustituyen otros atajos.`
    ));
    panel.child(Textarea.new(this.shortcutInput).id("changes-shortcut-input").w_full().px(8).py(5).rounded(6).border_1().border_color(t.border).bg(t.surface).text_color(t.foreground));
    if (this.settingsNotice) panel.child(div().text_color(t.ansi1).whitespace_normal().child(this.settingsNotice));
    panel.child(h_flex().gap(6)
      .child(button("editor-setting-save", this.settingsBusy ? "Guardando…" : "Guardar", cx => this.saveEditorSettings(cx)))
      .child(button("editor-setting-cancel", "Cancelar", cx => { if (!this.settingsBusy) { this.settingsOpen = false; cx.notify(); } })));
    return panel;
  }

  renderPullRequestComments(t) {
    const list = v_flex().id("pr-comments-list").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8);
    if (this.prLoading) return list.child(div().text_color(t.dim).child("Cargando pull request y comentarios…"));
    if (this.prError) return list.child(div().text_color(t.ansi1).whitespace_normal().child(this.prError));
    if (!this.pr) return list.child(div().text_color(t.dim).child(this.root ? "Selecciona Comments para consultar GitHub." : "No hay repositorio seleccionado."));
    list.child(div().font_semibold().whitespace_normal().child(`PR #${this.pr.number} · ${this.pr.title}`));
    if (this.prActionError) list.child(div().text_color(t.ansi1).whitespace_normal().child(this.prActionError));
    const unresolved = this.prThreads.filter(thread => !thread.isResolved);
    list.child(div().text_size(em(0.8)).text_color(t.dim).child(`${unresolved.length} hilos sin resolver`));
    if (!unresolved.length) list.child(div().text_color(t.dim).child("No hay comentarios de revisión sin resolver."));
    for (const thread of unresolved) {
      const comments = thread.comments?.nodes ?? [];
      const location = thread.line ?? thread.originalLine;
      const first = comments[0];
      const created = first?.createdAt ? new Date(first.createdAt) : null;
      const date = created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString("es-ES") : "";
      const card = v_flex().gap(5).p(8).rounded(6).bg(t.raised)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(thread.path).child(`${thread.path}${location ? `:${location}` : ""}`))
          .child(this.icon(`pr-open-${thread.id}`, "file", "Abrir diff del archivo", cx => this.pick({ path: thread.path, add: 0, del: 0 }, cx, "pr"), t)))
        .child(div().text_size(em(0.8)).text_color(t.dim).child([thread.isResolved ? "Resuelto" : "Abierto", first?.author?.login ?? "usuario eliminado", date, thread.isOutdated ? "Desactualizado" : ""].filter(Boolean).join(" / ")));
      const resolveButton = () => div().id(`pr-resolve-${thread.id}`).px(9).py(4).rounded(5).border(1).border_color(t.border).bg(t.surface)
        .text_color(thread.viewerCanResolve && !this.prActionBusy ? t.foreground : t.dim)
        .when(thread.viewerCanResolve && !this.prActionBusy, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .tooltip(thread.viewerCanResolve ? "Resolver hilo en GitHub" : "No tienes permiso para resolver este hilo")
        .on_click((_e, cx) => { if (thread.viewerCanResolve) this.prAction(cx, "resolve", thread); })
        .child("Resolver hilo");
      comments.forEach((comment, index) => {
        const reaction = comment.reactionGroups?.find(group => group.content === "THUMBS_UP");
        card.child(v_flex().gap(4).py(5)
        .when(index > 0, el => el.child(div().font_semibold().text_size(em(0.85)).child(comment.author?.login ?? "usuario eliminado")))
        .child(TextView.markdown(`pr-comment-${thread.id}-${index}`, comment.body || "").selectable().w_full().text_size(em(1.05)))
        .child(h_flex().w_full().justify_end().items_center().gap(6)
        .child(div().id(`pr-like-${comment.id}`).px(9).py(4).rounded(5).border(1).border_color(t.border).bg(reaction?.viewerHasReacted ? t.selected : t.surface).text_color(reaction?.viewerHasReacted ? t.accent : t.foreground)
          .when(!this.prActionBusy, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .tooltip(reaction?.viewerHasReacted ? "Quitar 👍" : "Reaccionar con 👍")
          .on_click((_e, cx) => this.prAction(cx, "reaction", thread, comment))
          .child(`👍 ${reaction?.users?.totalCount ?? 0}`))
        .when(index === comments.length - 1, el => el.child(resolveButton()))));
      });
      if (!comments.length) card.child(h_flex().w_full().justify_end().child(resolveButton()));
      if (thread.comments?.totalCount > comments.length) card.child(div().text_color(t.dim).child(`Se muestran ${comments.length} de ${thread.comments.totalCount} respuestas.`));
      list.child(card);
    }
    return list;
  }

  renderFileList(t) {
    const list = v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    const query = this.fileFilter.value();
    for (const [scope, label, count] of [
      ["staged", "Staged", this.stagedCount ?? 0],
      ["unstaged", "Unstaged", this.unstagedCount ?? 0],
    ]) {
      const isStaged = scope === "staged";
      const action = isStaged ? "unstage" : "stage";
      // A partially staged file appears twice. Render each group's own status
      // and line counts rather than the totals across index and working tree.
      const group = filterFiles(this.files, query)
        .filter((file) => (isStaged ? file.staged : file.unstaged))
        .map((file) => ({
          ...file,
          status: (isStaged ? file.stagedStatus : file.unstagedStatus) || file.status,
          ...(isStaged ? file.stagedStats : file.unstagedStats),
        }));
      if (!isStaged) list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
      list.child(
        h_flex()
          .id(`changes-section-${scope}`)
          .h(34)
          .px(8)
          .gap(6)
          .items_center()
          .flex_none()
          .child(div().font_semibold().text_size(em(0.9)).child(label))
          .child(div().text_size(em(0.8)).text_color(t.dim).child(query ? `${group.length}/${count}` : String(count)))
          .child(div().flex_1())
          .child(
            this.icon(
              `changes-${action}-all`,
              action,
              query ? (isStaged ? "Unstage filtered files" : "Stage filtered files") : (isStaged ? "Unstage all" : "Stage all"),
              (cx) => this.indexAction(action, null, cx),
              t,
              false,
              !(query ? group.length : count) || this.busy || this.loading,
              22,
            ),
          ),
      );
      if (!group.length) {
        list.child(
          div()
            .px(8)
            .pb(6)
            .text_size(em(0.85))
            .text_color(t.dim)
            .child(query && count ? "No matching files" : scope === "staged" ? "No staged changes" : "No unstaged changes"),
        );
        continue;
      }
      list.children(this.fileRows(group, scope, t));
    }
    if (!this.files.length)
      list.child(
        div()
          .p(10)
          .text_color(t.dim)
          .child(
            this.error ||
              (this.loading
                ? "Loading changes…"
                : this.root
                  ? "No uncommitted changes"
                  : "No folder selected"),
          ),
      );
    this.renderCommitted(list, t);
    return list;
  }

  renderCommitted(list, t) {
    const committed = this.committed;
    if (!committed) return;
    const query = this.fileFilter.value();
    const files = filterFiles(committed.files, query);
    list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
    list.child(
      h_flex()
        .id("changes-section-committed")
        .h(34)
        .px(8)
        .gap(6)
        .items_center()
        .flex_none()
        .child(div().font_semibold().text_size(em(0.9)).child("Committed"))
        .child(div().text_size(em(0.8)).text_color(t.dim).child(query ? `${files.length}/${committed.total}` : String(committed.total)))
        .child(div().flex_1())
        .child(
          div().min_w(0).truncate().text_size(em(0.8)).text_color(t.dim).child(`since ${committed.name}`),
        ),
    );
    if (files.length) list.children(this.fileRows(files, "committed", t));
    else
      list.child(
        div().px(8).pb(6).text_size(em(0.85)).text_color(t.dim).child(query && committed.files.length ? "No matching files" : "Nothing committed on this branch yet"),
      );
  }

  // Tree or flat rows for one group, honouring the sidebar's view toggle.
  fileRows(group, scope, t) {
    if (this.view === "flat") return group.map((file) => this.fileRow(file, 0, t, scope));
    const closed = new Set(
      [...this.closed].filter((k) => k.startsWith(scope + ":")).map((k) => k.slice(scope.length + 1)),
    );
    return fileTree(group, closed).map((row) =>
      row.kind === "file"
        ? this.fileRow(row.file, row.depth, t, scope)
        : this.folderRow(row, scope, t),
    );
  }

  renderCommitList(t) {
    const list = v_flex().id("commit-list").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    const { upstream, remoteHead } = this;
    const unpushed = upstream?.unpushed;
    const notPulled = (name, behind) => (behind ? `${name} · ${behind} not pulled` : name);
    // On the default branch the two are the same ref, so they share the upstream's line.
    const sameRef = remoteHead?.target === upstream?.name;
    let marked = false;
    if (this.commits.length && !this.upstream && !this.commitsLoading)
      list.child(
        div()
          .id("commit-no-upstream")
          .flex_none()
          .px(8)
          .py(4)
          .text_size(em(0.8))
          .text_color(t.dim)
          .child("This branch has no remote to compare with"),
      );
    for (const commit of this.commits) {
      const isNew = Boolean(unpushed?.has(commit.hash));
      const labels = [];
      if (upstream && !isNew && !marked) {
        marked = true;
        labels.push(notPulled(upstream.name, upstream.behind));
        if (sameRef) labels.push(remoteHead.name);
      }
      if (remoteHead && !sameRef && commit.hash === remoteHead.base)
        labels.push(notPulled(remoteHead.name, remoteHead.behind));
      if (labels.length)
        list.child(
          this.remoteMarker(
            labels[0].startsWith(upstream?.name) ? "commit-upstream" : "commit-remote-head",
            labels,
            t,
          ),
        );
      list.child(
        v_flex()
          .id(`commit-${commit.hash}`)
          .px(8)
          .py(6)
          .gap(2)
          .flex_none()
          .rounded(5)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.openCommit(commit, cx))
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .when(isNew, (el) =>
                el.child(
                  div()
                    .size(6)
                    .flex_none()
                    .rounded(3)
                    .bg(t.accent)
                    .accessibility_label("Not pushed"),
                ),
              )
              .child(div().flex_1().min_w(0).truncate().child(commit.subject || "(no message)")),
          )
          .child(
            h_flex()
              .gap(6)
              .text_size(em(0.8))
              .text_color(t.dim)
              .child(div().flex_1().truncate().child(`${commit.author} · ${timeAgo(commit.at)}`))
              .child(div().child(commit.short)),
          ),
      );
    }
    if (this.commitsError) list.child(div().p(10).text_color(t.ansi1).child(this.commitsError));
    else if (this.commitsLoading && !this.commits.length)
      list.child(div().p(10).text_color(t.dim).child("Loading commits…"));
    else if (!this.commits.length)
      list.child(div().p(10).text_color(t.dim).child(this.root ? "No commits yet" : "No folder selected"));
    else if (!this.commitsDone)
      list.child(
        div()
          .id("commit-more")
          .h(30)
          .flex()
          .items_center()
          .justify_center()
          .rounded(5)
          .text_size(em(0.85))
          .text_color(t.muted)
          .cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.loadCommits(cx, true))
          .child(this.commitsLoading ? "Loading…" : "Load more"),
      );
    return list;
  }

  renderCommitDetail(t) {
    const commit = this.selectedCommit;
    const list = v_flex().id("commit-detail").flex_1().min_h(0).overflow_y_scrollbar().p(6);
    list.child(
      h_flex()
        .id("commit-back")
        .h(28)
        .px(6)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .text_color(t.muted)
        .hover((el) => el.bg(t.hover))
        .on_click((_e, cx) => this.closeCommit(cx))
        .child(svg("mods/changes-plus/chevron-left.svg").size(11))
        .child(div().text_size(em(0.85)).child("Commits")),
    );
    list.child(div().px(8).py(4).font_semibold().whitespace_normal().child(commit.subject));
    const url = this.repo ? `https://github.com/${this.repo}/commit/${commit.hash}` : null;
    list.child(
      h_flex()
        .px(8)
        .gap(4)
        .flex_wrap()
        .text_size(em(0.8))
        .text_color(t.dim)
        .child(div().child(`${commit.author} · ${new Date(commit.at * 1000).toLocaleString()} ·`))
        .child(
          div()
            .id("commit-link")
            .child(commit.short)
            .when(Boolean(url), (el) =>
              el
                .cursor_pointer()
                .text_color(t.accent)
                .underline()
                .tooltip(`${url}\nCmd-click (Ctrl-click on other platforms) to open on GitHub`)
                .hover((s) => s.text_color(t.foreground))
                .on_click((event, cx) => {
                  if (event.modifiers?.platform || event.modifiers?.control) {
                    cx.stop_propagation();
                    cx.open_url(url);
                  }
                }),
            ),
        ),
    );
    if (commit.body)
      list.child(div().px(8).py(6).text_size(em(0.9)).text_color(t.muted).whitespace_normal().child(commit.body));
    list.child(div().h(1).w_full().flex_none().my(4).bg(t.border));
    list.child(
      h_flex()
        .h(34)
        .px(8)
        .gap(6)
        .items_center()
        .flex_none()
        .child(div().font_semibold().text_size(em(0.9)).child("Files"))
        .child(div().text_size(em(0.8)).text_color(t.dim).child(String(this.commitFiles.length))),
    );
    if (this.commitFilesError) list.child(div().px(8).text_color(t.ansi1).child(this.commitFilesError));
    else if (this.commitFilesLoading && !this.commitFiles.length)
      list.child(div().px(8).text_color(t.dim).child("Loading files…"));
    list.children(this.fileRows(this.commitFiles, "commit", t));
    return list;
  }

  folderRow(row, scope, t) {
    const closedKey = `${scope}:${row.path}`;
    const chevron = this.closed.has(closedKey) ? "chevron-right" : "chevron-down";
    return h_flex()
      .id(`changes-folder-${scope}-${row.path}`)
      .h(28)
      .pl(8)
      .gap(6)
      .flex_none()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.closed.has(closedKey)) this.closed.delete(closedKey);
        else this.closed.add(closedKey);
        cx.notify();
      })
      .children(this.guides(row.depth, 28, t))
      .child(svg(`mods/changes-plus/${chevron}.svg`).size(11).text_color(t.muted))
      .child(div().min_w(0).truncate().child(row.name));
  }

  renderCommitDropdown(t) {
    const available = Boolean(this.root && !this.busy && !this.loading);
    const choices = [
      { mode: "commit", label: "Commit", icon: "commit" },
      { mode: "amend", label: "Amend", icon: "amend", disabled: !this.hasHead },
    ];
    const menu = v_flex()
      .id("changes-commit-menu")
      .w(190)
      .p(5)
      .gap(2)
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_color(t.foreground)
      .track_focus(this.commitMenuFocus)
      .on_key_down((event, cx) => {
        const enabled = choices.filter((choice) => !choice.disabled);
        if (event.key === "up" || event.key === "down") {
          this.commitMenuIndex =
            (this.commitMenuIndex + (event.key === "down" ? 1 : enabled.length - 1)) %
            enabled.length;
        } else if (event.key === "enter") {
          this.setCommitMode(enabled[this.commitMenuIndex % enabled.length].mode, cx);
          this.commitTriggerFocus.focus();
        } else if (event.key === "escape") {
          this.commitMenuOpen = false;
          this.commitTriggerFocus.focus();
        } else return;
        cx.stop_propagation();
        cx.notify();
      });
    for (const [index, choice] of choices.entries()) {
      menu.child(
        h_flex()
          .id(`changes-mode-${choice.mode}`)
          .h(30)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(4)
          .text_size(12.8)
          .role("list_box_option")
          .aria_selected(this.commitMode === choice.mode)
          .when(!choice.disabled && index === this.commitMenuIndex, (el) =>
            el.bg(t.selected).aria_active_descendant(),
          )
          .text_color(choice.disabled ? t.dim : t.foreground)
          .tooltip(
            choice.mode === "amend"
              ? this.hasHead
                ? "Rewrite the latest commit; unstaged changes stay untouched"
                : "Create a first commit before amending"
              : "Create a commit from staged changes only",
          )
          .when(!choice.disabled, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_event, cx) => {
                this.setCommitMode(choice.mode, cx);
                this.commitTriggerFocus.focus();
              }),
          )
          .child(svg(`mods/changes-plus/${choice.icon}.svg`).size(14).flex_none())
          .child(choice.label),
      );
    }
    const trigger = div()
      .id("changes-commit-options")
      .w(30)
      .h(32)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .border_l(1)
      .border_color(t.border)
      .track_focus(this.commitTriggerFocus)
      .tooltip("Commit options")
      .accessibility_label("Commit options")
      .text_color(available ? t.foreground : t.dim)
      .when(available, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_key_down((event, cx) => {
            if (!["enter", "space", "up", "down"].includes(event.key)) return;
            this.commitMenuOpen = !this.commitMenuOpen;
            this.commitMenuIndex = this.commitMode === "amend" && this.hasHead ? 1 : 0;
            if (this.commitMenuOpen) this.commitMenuFocus.focus();
            cx.stop_propagation();
            cx.notify();
          }),
      )
      .child(svg("mods/changes-plus/chevron-down.svg").size(12));
    return Popover.new("changes-commit-dropdown")
      .open(Boolean(available && this.commitMenuOpen))
      .anchor("bottom_right")
      .track_focus(this.commitMenuFocus)
      .on_open_change((open, cx) => {
        this.commitMenuOpen = available && open;
        this.commitMenuIndex = this.commitMode === "amend" && this.hasHead ? 1 : 0;
        cx.notify();
      })
      .trigger(trigger)
      .when(available && this.commitMenuOpen, (el) => el.content(menu));
  }

  renderCommitFooter(t) {
    const enabled = this.canCommit();
    const amend = this.commitMode === "amend";
    const label =
      this.operation === "commit"
        ? "Committing…"
        : this.operation === "amend"
          ? "Amending…"
          : amend
            ? "Amend"
            : "Commit staged";
    return v_flex()
      .p(10)
      .gap(8)
      .flex_none()
      .border_t(1)
      .border_color(t.border)
      .child(
        Textarea.new(this.input)
          .id("changes-commit-message")
          .w_full()
          .h(84)
          .px(8)
          .py(7)
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(t.surface)
          .text_color(t.foreground)
          .text_size(em(0.9))
          .accessibility_label("Commit message"),
      )
      .child(
        h_flex()
          .h(32)
          .w_full()
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(t.raised)
          .text_size(em(0.9))
          .child(
            h_flex()
              .id("changes-commit")
              .h_full()
              .flex_1()
              .min_w(0)
              .px(10)
              .gap(7)
              .items_center()
              .justify_center()
              .rounded_l(5)
              .bg(enabled ? t.solid : t.raised)
              .text_color(enabled ? t.solid_foreground : t.dim)
              .tooltip(
                amend
                  ? "Amend the latest commit with this message and staged changes"
                  : "Commit staged changes only",
              )
              .accessibility_label(label)
              .when(enabled, (el) =>
                el
                  .cursor_pointer()
                  .hover((s) => s.bg(t.accent))
                  .on_click((_event, cx) => this.commit(cx)),
              )
              .child(
                svg(amend ? "mods/changes-plus/amend.svg" : "mods/changes-plus/commit.svg")
                  .size(14)
                  .flex_none(),
              )
              .child(label),
          )
          .child(this.renderCommitDropdown(t)),
      )
      .child(
        div()
          .text_size(em(0.8))
          .text_color(amend ? t.ansi3 : t.dim)
          .whitespace_normal()
          .child(
            this.amendLoading
              ? "Loading latest commit…"
              : this.conflicts
                ? "Resolve conflicts and stage the files before committing"
                : amend
                  ? "Amend rewrites the latest commit. Unstaged changes stay untouched."
                  : "Commit includes staged changes only",
          ),
      )
      .when(this.total > (this.settings.limits.files || MAX_FILES), (el) =>
        el.child(
          div()
            .text_size(em(0.8))
            .text_color(t.dim)
            .child(`First ${(this.settings.limits.files || MAX_FILES).toLocaleString()} files shown`),
        ),
      );
  }

  // ── Diff rendering (inline and side-by-side) ───────────────────────────────

  requestDiscard(cx) {
    const file = this.files.find(f => f.path === this.path);
    if (this.discardBusy || !this.root || !this.hasHead || !file || file.fresh ||
        file.stagedStatus === "A" || !["staged", "unstaged", "all"].includes(this.scope)) return;
    this.discardTarget = { path: this.path, root: this.root, on: this.on, context: this.contextKey() };
    cx.notify();
  }

  discardFile(cx) {
    const target = this.discardTarget;
    if (!target || this.discardBusy) return;
    this.discardBusy = true;
    this.discardTarget = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.git(["restore", "--source=HEAD", "--staged", "--worktree", "--", `:(literal)${target.path}`], target.root, target.on);
        if (result.code !== 0) throw new Error(result.stderr || "No se pudieron descartar los cambios");
        if (this.contextKey() === target.context) this.refresh(cx);
      } catch (error) {
        if (this.contextKey() === target.context) this.error = String(error.message || error);
      } finally {
        this.discardBusy = false;
        cx.notify();
      }
    });
  }

  renderDiff(root, t) {
    root.id("changes-plus-diff").track_focus(this.diffFocus)
      .on_key_down((e, cx) => this.diffKey(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endTextSelection(cx));
    const original =
      this.scope === "commit" || this.scope === "committed" || this.scope === "pr"
        ? this.commitFile
        : this.files.find((f) => f.path === this.path);
    const file = original
      ? {
          ...original,
          ...(this.scope === "staged"
            ? original.stagedStats
            : this.scope === "unstaged"
              ? original.unstagedStats
              : {}),
        }
      : null;
    const head = h_flex()
      .min_h(46)
      .px(14)
      .py(8)
      .gap(8)
      .items_center()
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("diff-copy-path")
          .flex_1()
          .min_w(0)
          .gap(8)
          .items_center()
          .when(!!this.path, (el) => el.cursor_pointer().tooltip("Copiar ruta del archivo")
            .on_click((_e, cx) => cx.write_to_clipboard(this.path)))
          .child(svg("mods/changes-plus/file.svg").size(15).text_color(t.muted))
          .child(div().min_w(0).whitespace_normal().font_semibold().child(this.path || "File diff")),
      );
    const setContext = value => cx => {
      this.diffContext = value;
      this.commentSelection = null;
      this.commentOpen = false;
      this.loadDiff(cx);
    };
    if (file)
      head
        .child(div().text_size(em(0.85)).text_color(t.ansi2).child(`+${file.add}`))
        .child(div().text_size(em(0.85)).text_color(t.ansi1).child(`−${file.del}`));
    head
      .child(this.icon("diff-context-compact", "context-compact", "Contexto compacto", setContext(3), t, this.diffContext === 3))
      .child(this.icon("diff-context-more", "context-more", "Mostrar 20 líneas de contexto", setContext(20), t, this.diffContext === 20))
      .child(this.icon("diff-context-full", "context-full", "Mostrar archivo completo", setContext(1000000), t, this.diffContext === 1000000))
      .child(this.icon("diff-editor", "file", "Abrir en editor (E)", cx => this.openEditor(cx), t, false, this.editorBusy || !this.path))
      .child(this.icon("diff-discard", "discard", "Descartar todos los cambios del archivo (U)", cx => this.requestDiscard(cx), t, false, this.discardBusy || !this.root || !this.hasHead || !file || file.fresh || file.stagedStatus === "A" || !["staged", "unstaged", "all"].includes(this.scope)))
      .child(this.icon("diff-refresh", "refresh", "Refresh diff", (cx) => this.refresh(cx), t))
      .child(
        this.icon(
          "diff-close",
          "close",
          "Close diff",
          () => {
            const tab = this.diffTab();
            if (tab) run("tab.close", { id: tab });
          },
          t,
        ),
      );
    root.child(head);
    if (this.discardTarget) {
      const target = this.discardTarget;
      root.child(h_flex().px(14).py(8).gap(10).items_center().bg(t.surface)
        .child(div().flex_1().text_color(t.ansi1).child(`¿Descartar todos los cambios de ${target.path}, incluidos los preparados? No se puede deshacer.`))
        .child(div().id("discard-cancel").px(8).py(4).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.discardTarget = null; cx.notify(); }).child("Cancelar"))
        .child(div().id("discard-confirm").px(8).py(4).cursor_pointer().text_color(t.ansi1).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.discardFile(cx)).child("Descartar")));
    }
    if (this.editorNotice) root.child(div().px(14).py(4).text_color(t.muted).child(this.editorNotice));
    if (this.editorChoices) {
      const choice = this.editorChoices;
      const picker = v_flex().px(14).py(8).gap(4).bg(t.surface)
        .child(div().child("Elige una sesión de Neovim:"));
      for (const candidate of choice.candidates) {
        picker.child(div().id(`editor-choice-${candidate.pid}`).px(8).py(4).rounded(4)
          .cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.openInEditor(choice, candidate, cx))
          .child(`${candidate.label} (${candidate.address}, proceso ${candidate.pid})`));
      }
      picker.child(div().id("editor-choice-cancel").px(8).py(4).cursor_pointer()
        .on_click((_e, cx) => { this.editorChoices = null; cx.notify(); }).child("Cancelar"));
      root.child(picker);
    }
    if (this.commentSelection && (this.commentSelection.path !== this.path || this.commentSelection.context !== this.context || this.commentSelection.scope !== this.scope))
      this.commentSelection = null;
    if (this.textRows !== this.rows) {
      this.textRows = this.rows;
      this.textRowsKey = JSON.stringify(this.rows);
      this.diffNumberDigits = Math.max(2, String(this.rows.reduce((max, row) => Math.max(max, row.old || 0, row.next || 0), 0)).length);
    }
    const textContext = JSON.stringify([this.path, this.context, this.scope, this.diffLayout]);
    if (this.textContext !== textContext || this.textContent !== this.textRowsKey) {
      this.textContext = textContext;
      this.textContent = this.textRowsKey;
      this.textSelection = null;
      this.textDragging = false;
      this.hoverLine = null;
    }
    root.child(
      h_flex()
        .h(30)
        .px(14)
        .gap(10)
        .items_center()
        .flex_none()
        .text_size(em(0.8))
        .text_color(t.dim)
        .child(
          div()
            .flex_1()
            .truncate()
            .child(
              `${this.scope === "pr" ? `${this.commitRef?.name} · base → head` : this.scope === "commit" ? `Commit ${this.commitRef?.short} · ${this.commitRef?.subject}` : this.scope === "committed" ? `Committed · ${this.commitRef?.name} → HEAD` : this.scope === "staged" ? "Staged · HEAD → Index" : this.scope === "unstaged" ? "Unstaged · Index → Working tree" : "All changes"} · ${this.root || ""}`,
            ),
        )
        .child(div().text_color(t.ansi2).child("+ Added"))
        .child(div().text_color(t.ansi1).child("− Removed")),
    );
    if (this.diffLoading && !this.rows.length)
      root.child(div().p(14).text_color(t.dim).child("Loading diff…"));
    if (this.error || this.note)
      root.child(
        div()
          .px(14)
          .py(8)
          .text_color(t.ansi1)
          .child(this.error || this.note),
      );
    if (!this.path)
      root.child(
        div().p(14).text_color(t.dim).child("Select a changed file in Changes to view its diff."),
      );
    const height = Math.ceil(em(1.65));
    const split = this.diffLayout === "split";
    if (split)
      root.child(
        h_flex()
          .h(28)
          .flex_none()
          .items_center()
          .border_y(1)
          .border_color(t.border)
          .text_size(em(0.8))
          .text_color(t.muted)
          .child(div().flex_1().px(12).child("Before"))
          .child(
            h_flex()
              .flex_1()
              .px(12)
              .gap(5)
              .items_center()
              .border_l(1)
              .border_color(t.border)
              .child(div().flex_1().child("After"))
              .child(
                this.icon(
                  "diff-scroll-left",
                  "chevron-left",
                  "Scroll both sides left",
                  (cx) => this.scrollSplit(-em(16), cx),
                  t,
                  false,
                  !this.splitOffset,
                  20,
                ),
              )
              .child(
                this.icon(
                  "diff-scroll-right",
                  "chevron-right",
                  "Scroll both sides right",
                  (cx) => this.scrollSplit(em(16), cx),
                  t,
                  false,
                  this.splitOffset >= Math.max(0, (this.width || 300) - 160),
                  20,
                ),
              ),
          ),
      );
    // Cache paired rows by array identity. Both sides share one virtual list,
    // which keeps their vertical positions aligned even for unequal hunks.
    if (this.pairedSource !== this.rows) {
      this.pairedSource = this.rows;
      this.pairedRows = splitDiffRows(this.rows);
    }
    const rows = split ? this.pairedRows : this.rows;
    const displayRows = this.diffDisplayRows(rows, split);
    if (this.commentOpen && this.commentSelection) {
      const s = this.commentSelection;
      const end = Math.max(s.start, s.end ?? s.start);
      const after = displayRows.findIndex(item => !item.thread && (s.layout === "text" ? item.index === end : split
        ? item.index === end
        : item.row[s.side] === end));
      if (after >= 0) {
        const agentCount = this.commentAgents().length;
        const composerHeight = this.commentInputHeight + 56 + (agentCount === 0 ? 24 : agentCount > 1 ? 24 + agentCount * 30 : 0) + (this.commentNotice ? 24 : 0);
        displayRows.splice(after + 1, 0, { composer: true, height: composerHeight });
        if (this.revealComposer && this.diffScroll.height) {
          this.diffScroll.top = Math.max(this.diffScroll.top, (after + 1) * height + composerHeight - this.diffScroll.height);
          this.revealComposer = false;
        }
      }
    }
    const openThread = (this.diffPrThreads ?? []).find(thread => thread.id === this.openPrThread);
    if (openThread) {
      const details = v_flex().px(14).py(6).gap(5).max_h(220).overflow_y_scrollbar().bg(t.raised)
        .child(h_flex().items_center().child(div().flex_1().font_semibold().child("Comentario del PR"))
          .child(this.icon("pr-thread-close", "close", "Cerrar comentario", cx => { this.openPrThread = null; cx.notify(); }, t)));
      openThread.comments.forEach((comment, index) => details.child(v_flex().gap(4)
        .child(div().font_semibold().child(comment.author))
        .child(TextView.markdown(`diff-pr-thread-${openThread.id}-${index}`, comment.body).selectable().w_full())));
      root.child(details);
    }
    const viewport = div()
      .flex_1()
      .min_h(0)
      .relative()
      .flex()
      .flex_col()
      .when(Boolean(codeFont()), (el) => el.font_family(codeFont()))
      .text_size(em(1));
    const body = this.diffScroll.view(displayRows, height, item => {
      if (item.composer) return this.commentPanel(t).h(item.height);
      if (item.thread) return this.prThreadRow(item.thread, t, height, split)
        .on_click((_e, cx) => this.diffItemClick(item.key, split, cx));
      return split ? this.splitRow(item.row, t, height, item.index) : this.diffRow(item.row, t, height, item.index);
    }, t, cx => this.endTextSelection(cx), split ? (delta, cx) => this.scrollSplit(delta, cx) : null);
    if (split) viewport.child(body);
    else viewport.child(div().id("factory-diff-x").size_full().overflow_x_scrollbar()
      .child(div().w_full().min_w(this.width || 300).h_full().flex().flex_col().child(body)));
    root.child(viewport);
    root.child(h_flex().h(27).px(12).gap(12).items_center().flex_none().border_t(1).border_color(t.border)
      .text_size(em(0.8)).text_color(t.muted)
      .child(this.commentOpen ? "Enter enviar   Shift+Enter nueva línea   Esc cancelar" : "Arrastrar para seleccionar texto · Ctrl+C copiar · + para comentar"));
    if (this.commentNotice && !this.commentOpen) root.child(div().px(12).text_size(em(0.8)).text_color(t.muted).child(this.commentNotice));
    if (this.truncated)
      root.child(
        div()
          .px(14)
          .py(6)
          .text_size(em(0.8))
          .text_color(t.dim)
          .child("Preview limited to 1,500 lines and 4,000 characters per line."),
      );
    return root;
  }

  // One horizontal offset moves both text columns, leaving line gutters fixed.
  scrollSplit(delta, cx) {
    this.splitOffset = Math.max(
      0,
      Math.min(Math.max(0, (this.width || 300) - 160), this.splitOffset + delta),
    );
    cx.notify();
  }

  diffDisplayRows(rows, split) {
    const threads = this.scope === "pr" ? (this.diffPrThreads ?? []) : [];
    const matches = new Map();
    for (const thread of threads) {
      const found = [];
      rows.forEach((row, index) => {
        const entry = split ? (thread.side === "LEFT" ? row.left : row.right) : row;
        const number = thread.side === "LEFT" ? entry?.old : entry?.next;
        if (number === thread.line) found.push(index);
      });
      if (found.length === 1) {
        const index = found[0];
        if (!matches.has(index)) matches.set(index, []);
        matches.get(index).push(thread);
      }
    }
    return rows.flatMap((row, index) => [
      { key: `line:${index}`, row, index },
      ...(matches.get(index) ?? []).map(thread => ({ key: `thread:${thread.id}`, thread })),
    ]);
  }

  prThreadRow(thread, t, height, split = false) {
    const first = thread.comments?.[0];
    const preview = String(first?.body ?? "").replace(/\s+/g, " ").slice(0, 180);
    const marker = div().id(`diff-pr-${thread.id}`).h(height).px(12).min_w(0).flex_1().bg(t.selected)
      .text_color(t.accent).truncate().hover(s => s.bg(t.hover))
      .child(`💬 ${first?.author ?? "GitHub"}: ${preview} · clic para leer`);
    if (!split) return marker.w_full();
    const empty = div().flex_1().min_w(0).h(height);
    return h_flex().id(`diff-pr-row-${thread.id}`).w_full().h(height).children(thread.side === "LEFT" ? [marker, empty] : [empty, marker]);
  }

  diffItemClick(key, split, cx) {
    if (key.startsWith("thread:")) {
      this.openPrThread = this.openPrThread === key.slice(7) ? null : key.slice(7);
      cx.notify();
    }
  }

  endTextSelection(cx) {
    if (!this.textDragging) return;
    this.textDragging = false;
    cx.notify();
  }

  selectionText() {
    const rows = this.textSelection?.split ? this.pairedRows : this.rows;
    if (this.copiedSelection !== this.textSelection || this.copiedRows !== rows) {
      this.copiedSelection = this.textSelection;
      this.copiedRows = rows;
      this.copiedText = selectedText(this.textSelection, rows);
    }
    return this.copiedText || "";
  }

  commentMarker(index, split, side, t, height) {
    if (split && !this.pairedRows[index]?.[side]) return div().w(20).h(height).flex_none();
    const selection = this.textSelection;
    const hasText = Boolean(this.selectionText());
    let last = hasText ? orderedRange(selection)[1].index : this.hoverLine?.index;
    if (hasText && split) {
      const first = orderedRange(selection)[0].index;
      while (last > first && !this.pairedRows[last]?.[selection.side]) last--;
    }
    const visible = index === last && (!split || (hasText ? selection.side : this.hoverLine?.side) === side);
    return div().w(20).h(height).flex_none().child(visible
      ? this.icon(`comment-line-${index}-${side}`, "comment-add", "Comentar selección o línea", cx => {
          const source = split ? this.pairedRows : this.rows;
          const first = hasText ? orderedRange(selection)[0] : { index };
          this.commentSelection = { path: this.path, context: this.context, scope: this.scope,
            layout: "text", split, side, start: first.index, end: index,
            excerpt: hasText ? this.selectionText() : (split ? source[index][side]?.text : source[index]?.text) ?? "" };
          this.commentOpen = true;
          this.commentNotice = null;
          this.revealComposer = true;
          this.commentInput.focus();
          cx.notify();
        }, t, false, this.textDragging, 20)
      : div());
  }

  selectableCode(row, syntaxSide, t, fallback, index, split, side) {
    const text = row?.text ?? "";
    const selection = this.textSelection;
    const range = selection && selection.split === split && (!split || selection.side === side)
      ? selectedOffsets(selection, index, text.length) : null;
    const line = this.syntaxLine(row, syntaxSide, t, fallback, range).relative().cursor_text()
      .id(`select-code-${split}-${index}-${side}`)
      .on_mouse_down("left", (event, cx) => {
        const offset = columnOffset(text, Math.max(0, event.local_position?.x ?? 0) / (this.diffCharWidth || em(0.6)));
        const [start, end] = event.click_count >= 3 ? [0, text.length]
          : event.click_count === 2 ? wordRange(text, offset) : [offset, offset];
        this.textSelection = { split, side, anchor: { index, offset: start }, focus: { index, offset: end } };
        this.textDragging = event.click_count === 1;
        this.commentOpen = false;
        this.commentSelection = null;
        this.diffFocus.focus();
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_move((event, cx) => {
        if (this.hoverLine?.index !== index || this.hoverLine?.side !== side) {
          this.hoverLine = { index, side };
          cx.notify();
        }
        if (!this.textDragging || this.textSelection?.split !== split || (split && this.textSelection.side !== side)) return;
        const offset = columnOffset(text, Math.max(0, event.local_position.x) / (this.diffCharWidth || em(0.6)));
        if (this.textSelection.focus.index === index && this.textSelection.focus.offset === offset) return;
        this.textSelection = { ...this.textSelection, focus: { index, offset } };
        cx.notify();
      });
    // Measure the actual mono font instead of assuming a width from its size.
    return line.child(div().absolute().left(0).top(0).opacity(0).whitespace_nowrap()
      .on_size_change((size, cx) => {
        const width = size.width / 10;
        if (width > 0 && Math.abs(width - (this.diffCharWidth || 0)) > 0.01) { this.diffCharWidth = width; cx.notify(); }
      }).child("MMMMMMMMMM"));
  }

  commentAgents() {
    return agents().filter(a => a.space === this.diffSpace &&
      (a.app === "opencode" || a.program?.key === "opencode" || a.program?.name === "OpenCode"));
  }

  diffKey(event, cx) {
    const key = String(event.key || "").toLowerCase();
    if (key === "c" && (event.modifiers?.control || event.modifiers?.platform) && !event.modifiers?.alt && !this.commentOpen) {
      const text = this.selectionText();
      if (!text) return;
      cx.write_to_clipboard(text);
      cx.stop_propagation();
      return;
    }
    if (event.modifiers?.control || event.modifiers?.alt || event.modifiers?.platform) return;
    if (key === "escape" && this.commentOpen) {
      this.commentOpen = false;
      this.diffFocus.focus();
    } else if (key === "escape" && this.textSelection) {
      this.textSelection = null;
    } else if (key === "e" && !this.commentOpen && !event.modifiers?.shift) {
      this.openEditor(cx);
    } else if (key === "u" && !this.commentOpen && !event.modifiers?.shift) {
      this.requestDiscard(cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  openEditor(cx) {
    if (this.editorBusy || !this.root || !this.path) return;
    const root = this.root, path = this.path, on = this.on;
    const selection = this.commentSelection;
    let line = null;
    if (selection?.layout === "inline" && selection.side === "next") line = Math.min(selection.start, selection.end ?? selection.start);
    if (selection?.layout === "split") line = this.pairedRows[Math.min(selection.start, selection.end ?? selection.start)]?.right?.next;
    if (selection?.layout === "text") {
      const row = selection.split ? this.pairedRows[selection.start]?.[selection.side] : this.rows[selection.start];
      line = row?.next ?? row?.old;
    }
    this.editorBusy = true;
    this.editorNotice = null;
    this.editorChoices = null;
    cx.notify();
    cx.spawn(async cx => {
      let handingOff = false;
      try {
        const exists = await exec("test", ["-f", `${root}/${path}`], { on });
        if (exists.code !== 0) throw new Error("El archivo no existe en el directorio de trabajo.");
        if (this.settings.editor.type === "command") {
          if (on) throw new Error("El comando personalizado no admite archivos remotos.");
          const args = editorCommand(parseEditorCommand(this.settings.editor.command), `${root}/${path}`, line);
          if (this.root !== root || this.path !== path) throw new Error("El archivo seleccionado ha cambiado; vuelve a intentarlo.");
          const result = await exec(args[0], args.slice(1), { cwd: root });
          if (result.code !== 0) throw new Error(result.stderr || "El editor devolvió un error.");
          this.editorNotice = ["commit", "committed", "pr"].includes(this.scope) ? "El editor muestra el archivo local, que puede diferir de esta revisión." : null;
          return;
        }
        if (this.settings.editor.type !== "nvim") throw new Error("Tipo de editor no válido; revisa los ajustes.");
        const installed = await exec("which", ["nvim"], { on });
        if (installed.code !== 0) throw new Error("No se encuentra Neovim.");
        const space = spaces().find(s => s.id === this.diffSpace);
        const tabIds = new Set((space?.tabs ?? []).map(t => t.id));
        const terminalPanes = panes().filter(p => tabIds.has(p.tab) && p.terminal);
        const addresses = terminalPanes.map(p => p.terminal);
        let candidates = [];
        if (!on && addresses.length) {
          const result = await exec("python3", [`${appHome()}/mods/changes-plus/nvim_sessions.py`, "list", JSON.stringify(addresses)]);
          if (result.code !== 0) throw new Error(result.stderr || "No se pudieron buscar sesiones de Neovim.");
          candidates = JSON.parse(result.stdout).map(candidate => {
            const pane = terminalPanes.find(p => p.terminal === candidate.address);
            const tab = space.tabs.find(t => t.id === pane?.tab);
            return { ...candidate, label: tab?.name || candidate.address, tab: pane?.tab };
          }).filter(candidate => candidate.tab);
        }
        const choice = { root, path, on, line: Number.isSafeInteger(line) && line > 0 ? line : 0, addresses, candidates, space: this.diffSpace };
        if (this.root !== root || this.path !== path) throw new Error("El archivo seleccionado ha cambiado; vuelve a intentarlo.");
        if (candidates.length > 1) this.editorChoices = choice;
        else if (candidates.length === 1) { handingOff = this.openInEditor(choice, candidates[0], cx); }
        else {
          const args = ["nvim"];
          if (choice.line) args.push(`+${choice.line}`);
          args.push("--", `${root}/${path}`);
          run("tab.new", { space: choice.space, name: path.split("/").pop(), folder: root, argv: args });
        }
        this.editorNotice = ["commit", "committed", "pr"].includes(this.scope) ? "Neovim muestra el archivo local, que puede diferir de esta revisión." : null;
      } catch (error) {
        this.editorNotice = `No se pudo abrir el editor: ${String(error?.message ?? error)}`;
      } finally {
        if (!handingOff) this.editorBusy = false;
        cx.notify();
      }
    });
  }

  openInEditor(choice, candidate, cx) {
    if (this.root !== choice.root || this.path !== choice.path || this.diffSpace !== choice.space) {
      this.editorChoices = null;
      this.editorNotice = "El archivo seleccionado ha cambiado; vuelve a intentarlo.";
      cx.notify(); return false;
    }
    this.editorChoices = null;
    this.editorBusy = true;
    const target = { address: candidate.address, pid: candidate.pid, socket: candidate.socket };
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [`${appHome()}/mods/changes-plus/nvim_sessions.py`, "open", JSON.stringify(choice.addresses), JSON.stringify(target), `${choice.root}/${choice.path}`, String(choice.line)]);
        if (result.code !== 0) throw new Error(result.stderr || "No se confirmó la apertura; comprueba Neovim antes de reintentar.");
        run("tab.select", { id: candidate.tab });
        run("pane.focus", { terminal: candidate.address });
      } catch (error) {
        this.editorNotice = `No se pudo confirmar la apertura: ${String(error?.message ?? error)}`;
      } finally {
        this.editorBusy = false;
        cx.notify();
      }
    });
    return true;
  }

  sendComment(cx, insertOnly = false) {
    const selection = this.commentSelection;
    const text = this.commentInput.value().trim();
    const candidates = this.commentAgents();
    const target = candidates.length === 1 ? candidates[0] : candidates.find(a => a.address === this.commentTarget);
    if (!selection || !text || this.commentBusy) return;
    if (!target) {
      this.commentOpen = true;
      this.revealComposer = true;
      this.commentNotice = candidates.length ? "Elige una sesión antes de continuar." : "No hay sesiones de OpenCode en este espacio.";
      cx.notify(); return;
    }
    if (target.status !== "idle" && target.status !== "working") {
      this.commentNotice = "La sesión no está disponible para recibir mensajes."; cx.notify(); return;
    }
    let reference;
    try { reference = commentReference(selection, this.rows, this.pairedRows); }
    catch (error) { this.commentNotice = String(error?.message ?? error); cx.notify(); return; }
    const message = `${reference}\n\n${text}`.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (message.length > 32000) { this.commentNotice = "El comentario y el fragmento superan el límite de 32000 caracteres."; cx.notify(); return; }
    if (insertOnly) {
      this.commentBusy = true;
      this.commentNotice = null;
      cx.spawn(async cx => {
        try {
          const result = await exec("python3", [`${appHome()}/mods/changes-plus/paste_to_agent.py`, target.address, message]);
          if (result.code !== 0) throw new Error(result.stderr || "No se pudo insertar el comentario.");
          this.commentNotice = "Comentario insertado sin enviar.";
          run("agent.focus", { terminal: target.address });
        } catch (e) {
          this.commentNotice = `No se pudo insertar: ${String(e?.message ?? e)}`;
        } finally {
          this.commentBusy = false;
          cx.notify();
        }
      });
      cx.notify(); return;
    }
    this.commentBusy = true; this.commentNotice = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("hc", ["send", "--if", target.status, target.address, message]);
        if (result.code !== 0) throw new Error(result.stderr || "No se pudo confirmar el envío; comprueba el chat antes de reintentar.");
        this.commentInput.set_value(""); this.commentSelection = null; this.commentOpen = false; this.commentNotice = "Comentario enviado a OpenCode.";
        run("agent.focus", { terminal: target.address });
      } catch (e) { this.commentNotice = `Envío no confirmado: ${String(e?.message ?? e)} Comprueba el chat antes de reintentar.`; }
      finally { this.commentBusy = false; cx.notify(); }
    });
  }

  commentPanel(t) {
    const selection = this.commentSelection;
    const candidates = this.commentAgents();
    const button = (id, label, click) => div().id(id).px(8).py(4).rounded(4).bg(t.raised).hover(s => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
    const panel = v_flex().id("diff-comment-composer").px(14).py(6).gap(5).flex_none().text_size(em(0.85))
      .bg(t.surface).border_1().border_color(t.accent).rounded(6)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (selection) {
      panel.child(div().id("diff-comment-input-size").w_full().flex_none()
        .on_size_change((size, cx) => {
          const height = Math.ceil(size.height);
          if (height > 0 && height !== this.commentInputHeight) {
            this.commentInputHeight = height;
            this.revealComposer = true;
            cx.notify();
          }
        })
        .child(Textarea.new(this.commentInput).w_full().text_size(em(1.1))));
      if (candidates.length === 0) panel.child(div().text_color(t.ansi3).child("No hay sesiones de OpenCode en este espacio."));
      if (candidates.length > 1) panel.child(v_flex().gap(3).child(div().child("Elige sesión de OpenCode:"))
        .children(candidates.map(a => button(`comment-target-${a.address}`, `${a.address === this.commentTarget ? "●" : "○"} ${a.title || a.tab_name || a.address} (${a.address}, ${a.status})`, cx => { this.commentTarget = a.address; cx.notify(); }))));
      panel.child(h_flex().gap(6)
        .child(button("comment-send", this.commentBusy ? "Enviando…" : "Enviar (Enter)", cx => this.sendComment(cx)))
        .child(button("comment-insert", "Insertar sin enviar", cx => this.sendComment(cx, true)))
        .child(button("comment-clear", "Cerrar (Esc)", cx => { this.commentOpen = false; this.diffFocus.focus(); cx.notify(); })));
    }
    if (this.commentNotice) panel.child(div().text_color(t.muted).child(this.commentNotice));
    return panel;
  }

  splitRow(row, t, height, index) {
    const numberWidth = Math.ceil((this.diffNumberDigits || 3) * (this.diffCharWidth || em(0.6)));
    if (row.kind !== "pair")
      return div().id(`diff-header-pair-${index}`)
        .h(height)
        .px(12)
        .w_full()
        .bg(t.raised)
        .text_color(row.kind === "@" ? t.accent : t.dim)
        .truncate()
        .child(row.text);
    const line = h_flex().id(`diff-hover-pair-${index}`).h(height).w_full()
      .hover((s) => s.bg(t.hover));
    for (const [side, entry] of [
      ["left", row.left],
      ["right", row.right],
    ]) {
      const changed = entry?.kind === "+" || entry?.kind === "-";
      const color = entry?.kind === "+" ? t.ansi2 : entry?.kind === "-" ? t.ansi1 : t.foreground;
      line.child(
        h_flex()
          .id(`diff-hover-${index}-${side}`)
          .on_hover((hovered, cx) => {
            if (hovered) this.hoverLine = { index, side };
            else if (this.hoverLine?.index === index && this.hoverLine?.side === side) this.hoverLine = null;
            cx.notify();
          })
          .flex_1()
          .min_w(0)
          .h_full()
          .gap(2)
          .items_center()
          .overflow_hidden()
          .when(side === "right", (el) => el.border_l(1).border_color(t.border))
          .when(changed, (el) => el.bg(color + "18"))
          .when(!entry, (el) => el.bg(t.raised + "80"))
          .child(this.commentMarker(index, true, side, t, height))
          .child(
            div()
              .w(numberWidth)
              .flex_none()
              .text_right()
              .text_color(t.dim)
              .child(entry ? String((side === "left" ? entry.old : entry.next) ?? "") : ""),
          )
          .child(
            div()
              .w(10)
              .flex_none()
              .text_color(color)
              .child(changed ? entry.kind : ""),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .overflow_hidden()
              .tooltip(entry?.text || "")
              .child(
                this.selectableCode(entry, side === "left" ? "old" : "new", t, color, index, true, side)
                  .w(this.width || 300)
                  .flex_none()
                  .ml(-this.splitOffset)
                  .whitespace_nowrap(),
              ),
          ),
      );
    }
    return line;
  }

  diffRow(row, t, height, index) {
    const numberWidth = Math.ceil((this.diffNumberDigits || 3) * (this.diffCharWidth || em(0.6)));
    if (row.kind === "@")
      return div().id(`diff-header-${index}`).h(height).px(12).w_full().bg(t.raised).text_color(t.accent).child(row.text);
    const color = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : t.foreground;
    return h_flex()
      .id(`diff-hover-${index}`)
      .on_hover((hovered, cx) => {
        if (hovered) this.hoverLine = { index, side: "inline" };
        else if (this.hoverLine?.index === index) this.hoverLine = null;
        cx.notify();
      })
      .h(height)
      .w_full()
      .gap(2)
      .items_center()
      .when(row.kind === "+" || row.kind === "-", (el) => el.bg(color + "18"))
      .hover((s) => s.bg(t.hover))
      .child(this.commentMarker(index, false, "inline", t, height))
      .child(
        div()
          .w(numberWidth)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(row.old === undefined ? "" : String(row.old)),
      )
      .child(
        div()
          .w(numberWidth)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(row.next === undefined ? "" : String(row.next)),
      )
      .child(div().w(10).flex_none().text_color(color).child(row.kind))
      .child(
        this.selectableCode(row, row.next !== undefined ? "new" : "old", t, color, index, false, "inline")
          .flex_1()
          .min_w(0)
          .whitespace_nowrap(),
      );
  }

  syntaxLine(row, side, t, fallback, range = null) {
    const number = side === "new" ? row?.next : row?.old;
    const tokens = number === undefined ? null : this.syntaxTokens?.get(`${side}:${number}`);
    const colors = { keyword: t.ansi5, string: t.ansi2, comment: t.muted, number: t.ansi3,
      literal: t.ansi3, function: t.ansi4, type: t.ansi6, property: t.ansi4, plain: fallback };
    let offset = 0, column = 0;
    const chunks = [];
    for (const token of tokens ?? [{ text: row?.text || " ", kind: "plain" }]) {
      const end = offset + token.text.length;
      const cuts = [offset, ...(range ?? []).filter(n => n > offset && n < end), end].sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const raw = token.text.slice(cuts[i] - offset, cuts[i + 1] - offset);
        const text = raw.replace(/\t|[^\t]/gu, char => {
          if (char !== "\t") { column++; return char; }
          const count = 4 - column % 4; column += count; return " ".repeat(count);
        });
        chunks.push(div().flex_none().whitespace_nowrap().text_color(colors[token.kind] ?? fallback)
          .when(Boolean(range && cuts[i] >= range[0] && cuts[i] < range[1]), el => el.bg(t.selection))
          .child(text));
      }
      offset = end;
    }
    return h_flex().gap(0).children(chunks);
  }
}
