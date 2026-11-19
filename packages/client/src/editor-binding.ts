import { javascript } from '@codemirror/lang-javascript';
import { Annotation, EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { SyncClient } from './sync-client.js';

const remote = Annotation.define<boolean>();
const setRemoteCursors = StateEffect.define<DecorationSet>();

const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setRemoteCursors)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CursorWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }

  override eq(other: CursorWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'remote-cursor';
    caret.style.borderLeftColor = this.color;
    const label = document.createElement('span');
    label.className = 'remote-cursor-label';
    label.textContent = this.name;
    label.style.backgroundColor = this.color;
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Two way binding between a CodeMirror 6 view and a SyncClient, including remote cursors. */
export class EditorBinding {
  private readonly view: EditorView;

  constructor(
    parent: HTMLElement,
    private readonly sync: SyncClient,
  ) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: sync.text(),
        extensions: [
          basicSetup,
          javascript(),
          remoteCursorField,
          EditorView.updateListener.of((u) => this.onUpdate(u)),
        ],
      }),
    });
    sync.onRemoteChange = () => {
      this.pullRemote();
      this.refreshPresence();
    };
    sync.onPresence = () => this.refreshPresence();
    this.refreshPresence();
  }

  destroy(): void {
    this.sync.onRemoteChange = () => {};
    this.sync.onPresence = () => {};
    this.view.destroy();
  }

  /** Local edit: feed the changed ranges to the CRDT, last range first so earlier offsets stay valid. */
  private onUpdate(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return;
    if (update.transactions.some((tr) => tr.annotation(remote) === true)) return;
    if (update.docChanged) {
      const changes: Array<{ from: number; to: number; text: string }> = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, text: inserted.toString() });
      });
      for (let i = changes.length - 1; i >= 0; i--) {
        const c = changes[i];
        if (c !== undefined) this.sync.applyLocal(c.from, c.to - c.from, c.text);
      }
    }
    const sel = update.state.selection.main;
    this.sync.setLocalCursor(sel.anchor, sel.head);
  }

  /** Remote change: replace only the differing middle of the document. */
  private pullRemote(): void {
    const next = this.sync.text();
    const cur = this.view.state.doc.toString();
    if (next === cur) return;
    let start = 0;
    const minLen = Math.min(cur.length, next.length);
    while (start < minLen && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = cur.length;
    let endNext = next.length;
    while (
      endCur > start &&
      endNext > start &&
      cur.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)
    ) {
      endCur--;
      endNext--;
    }
    this.view.dispatch({
      changes: { from: start, to: endCur, insert: next.slice(start, endNext) },
      annotations: remote.of(true),
    });
  }

  /** Resolves each remote cursor's element ids to current positions and redraws them. */
  private refreshPresence(): void {
    const ranges: Range<Decoration>[] = [];
    const docLength = this.view.state.doc.length;
    for (const p of this.sync.remote.values()) {
      if (p.cursor === null) continue;
      const head = this.sync.resolve(p.cursor.head);
      const anchor = this.sync.resolve(p.cursor.anchor);
      if (head === undefined || anchor === undefined) continue;
      const h = Math.min(head, docLength);
      const a = Math.min(anchor, docLength);
      if (a !== h) {
        ranges.push(
          Decoration.mark({ attributes: { style: `background-color: ${p.color}33` } }).range(
            Math.min(a, h),
            Math.max(a, h),
          ),
        );
      }
      ranges.push(Decoration.widget({ widget: new CursorWidget(p.name, p.color), side: 1 }).range(h));
    }
    this.view.dispatch({ effects: setRemoteCursors.of(Decoration.set(ranges, true)) });
  }
}
