// Fixed-height, windowed diff rows. Ordinary elements can receive drag events.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export class DiffScroll {
  constructor() {
    this.top = 0;
    this.height = 0;
    this.thumbDrag = null;
  }

  view(items, rowHeight, draw, t, onRelease, onHorizontal) {
    const offsets = [0];
    for (const item of items) offsets.push(offsets[offsets.length - 1] + (item.height || rowHeight));
    const total = offsets[offsets.length - 1];
    const max = Math.max(0, total - this.height);
    this.top = Math.max(0, Math.min(this.top, max));
    let start = 0;
    while (start < items.length && offsets[start + 1] <= this.top) start++;
    let end = start;
    const bottom = this.top + (this.height || rowHeight * 60);
    while (end < items.length && offsets[end] < bottom + rowHeight) end++;
    const visible = [];
    for (let i = start; i < end; i++) visible.push(draw(items[i]));
    const overflow = this.height > 0 && total > this.height;
    const thumbHeight = overflow ? Math.max(24, this.height * this.height / total) : 0;
    const travel = Math.max(1, this.height - thumbHeight);
    const thumbTop = max ? this.top / max * travel : 0;
    return div().id("better-diff-scroll").relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((size, cx) => {
        if (this.height !== size.height) { this.height = size.height; cx.notify(); }
      })
      .on_scroll_wheel((event, cx) => {
        const horizontal = event.delta.x || (event.modifiers?.shift ? event.delta.y : 0);
        if (horizontal && onHorizontal) { onHorizontal(-horizontal, cx); cx.stop_propagation(); return; }
        const next = Math.max(0, Math.min(max, this.top - event.delta.y));
        if (next !== this.top) { this.top = next; cx.notify(); }
      })
      .on_mouse_move((event, cx) => {
        if (!this.thumbDrag) return;
        this.top = Math.max(0, Math.min(max, this.thumbDrag.top + (event.position.y - this.thumbDrag.y) * max / travel));
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => { this.thumbDrag = null; onRelease(cx); })
      .child(v_flex().absolute().left(0).right(0).top(offsets[start] - this.top).children(visible))
      .when(overflow, el => el.child(div().id("better-diff-thumb").absolute().right(1).top(thumbTop).w(6).h(thumbHeight)
        .rounded(3).bg(t.border).hover(s => s.bg(t.muted))
        .on_mouse_down("left", (event, cx) => { this.thumbDrag = { y: event.position.y, top: this.top }; cx.stop_propagation(); })));
  }
}
