import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, props, theme, window, shared, layout, settings, hc, notify, checking, appHome, readTextFile, writeTextFile } from "herdr";
import { DEFAULT_RULES, validateRules, targetForClick } from "./autorun.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.starting = new Set();
    this.rules = [];
    this.raw = null;
    this.loaded = false;
    this.error = "";
    this.nameInput = InputState.new({ placeholder: "Nombre exacto, por ejemplo OpenCode" });
    this.commandInput = InputState.new({ placeholder: "Comando, por ejemplo opencode" });
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    if (!checking()) cx.spawn(async (cx) => {
      try {
        this.raw = await readTextFile(`${appHome()}/mods/tabs-autorun/config.json`);
        this.rules = validateRules(this.raw === null ? DEFAULT_RULES : JSON.parse(this.raw));
        this.loaded = true;
      } catch (e) { this.error = `No se pudo cargar la configuración: ${e.message}`; }
      cx.notify();
    });
  }

  startOnClick(space, tab, cx) {
    const target = targetForClick(space, tab, panes(), this.rules);
    if (!this.loaded || !target || this.starting.has(target.terminal)) return;
    const { terminal, command } = target;
    this.starting.add(terminal);
    cx.spawn(async (_cx) => {
      try {
        // Recheck immediately before sending, but this is not atomic with typing.
        const currentSpace = spaces().find(s => s.id === space.id);
        const currentTab = currentSpace?.tabs.find(t => t.id === tab.id);
        const next = targetForClick(currentSpace, currentTab, panes(), this.rules);
        if (!next || next.terminal !== terminal || next.command !== command) return;
        const result = await hc(["send", terminal, command]);
        if (result.code !== 0) notify({ title: "Tabs Autorun", body: "No se pudo ejecutar el comando.", level: "error" });
      } catch {
        notify({ title: "Tabs Autorun", body: "No se pudo ejecutar el comando.", level: "error" });
      } finally {
        this.starting.delete(terminal);
      }
    });
  }

  saveRules(rules, cx) {
    if (!this.loaded || this.saving) return;
    let valid;
    try { valid = validateRules(rules); }
    catch (e) { this.error = e.message; cx.notify(); return; }
    this.saving = true;
    cx.spawn(async (cx) => {
      try {
        const text = JSON.stringify(valid, null, 2) + "\n";
        await writeTextFile(`${appHome()}/mods/tabs-autorun/config.json`, text, this.raw);
        this.raw = text;
        this.rules = valid;
        this.error = "";
      } catch (e) { this.error = `No se guardó: ${e.message}. Cierra y abre los ajustes para recargar.`; }
      this.saving = false;
      cx.notify();
    });
  }

  renderSettings() {
    const t = theme();
    const button = (id, text, fn) => div().id(id).px(10).py(6).rounded(6).bg(t.raised)
      .text_color(t.foreground).on_click(fn).child(text);
    return v_flex().w_full().p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().justify_between().child(div().text_size(16).child("Tabs Autorun"))
        .child(button("close-settings", "Cerrar", () => closeOverlay(props().overlay))))
      .child(div().text_size(12).text_color(t.muted).child("Reglas globales por nombre exacto de pestaña. El comando se envía a la shell al hacer clic."))
      .child(div().text_size(12).text_color(t.blocked).child("Riesgo: puede ejecutarse un borrador o llegar a otro programa."))
      .child(v_flex().max_h(240).overflow_y_scrollbar().gap(4).children(this.rules.map((r, i) => h_flex().id(`rule-${i}`).gap(8).items_center()
        .child(div().flex_1().child(`${r.name} → ${r.command}`))
        .child(button(`edit-${i}`, "Editar", (_e, cx) => {
          this.editing = i;
          this.nameInput.set_value(r.name);
          this.commandInput.set_value(r.command);
          cx.notify();
        }))
        .child(button(`remove-${i}`, "Eliminar", (_e, cx) => this.saveRules(this.rules.filter((_, n) => n !== i), cx))))))
      .child(Input.new(this.nameInput).h(34).px(8).bg(t.background).border_1().border_color(t.input))
      .child(Input.new(this.commandInput).h(34).px(8).bg(t.background).border_1().border_color(t.input))
      .child(button("add-rule", this.editing === undefined ? "Añadir regla" : "Guardar cambios", (_e, cx) => {
        const entry = { name: this.nameInput.value(), command: this.commandInput.value() };
        const next = this.editing === undefined ? [...this.rules, entry]
          : this.rules.map((r, i) => i === this.editing ? entry : r);
        this.saveRules(next, cx);
      }))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)));
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    if (props()?.mode === "settings") return this.renderSettings();
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", (e, cx) => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else {
            run("tab.select", { id: c.id });
            if (e.click_count === 1) this.startOnClick(space, c, cx);
          }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(button("autorun-settings", "⚙", () => openOverlay({ mod: "tabs-autorun", kind: "dialog", width: 520, props: { mode: "settings" } })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-autorun/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-autorun/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-autorun/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
