import { View, div } from "gpui-kit";
import { checking, props, run, spaces } from "herdr";
import { missingTabs } from "./rules.js";

export default class TabsAutorun extends View {
  init(_props, cx) {
    this.pending = new Set();
    if (checking()) return;
    // Reconcile gently; the user can change spaces without a background redraw loop.
    cx.timer.every(3000, () => this.reconcile());
  }

  reconcile() {
    const spacesNow = spaces();
    const rules = props()?.spaces;
    const missing = missingTabs(spacesNow, rules);
    const missingKeys = new Set(missing.map(item => JSON.stringify([item.space, item.name])));
    for (const key of this.pending) {
      if (!missingKeys.has(key)) this.pending.delete(key);
    }
    for (const action of missing) {
      const key = JSON.stringify([action.space, action.name]);
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      // Do not start a command or change the selected tab during reconciliation.
      run("tab.new", { space: action.space, name: action.name, focus: false });
    }
  }

  render() {
    return div();
  }
}
