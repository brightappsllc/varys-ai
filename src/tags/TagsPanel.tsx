/**
 * Tags Panel — Tag Zoo
 *
 * Tag JSON shape: { "value": string, "topic": string, "description": string, "color": string }
 *
 * Layout:
 *   1. Create Tag form — two-column:
 *        LEFT  — inputs (value · description · topic dropdown · color swatches)
 *        RIGHT — live JSON preview
 *   2. Tag library — two-column:
 *        LEFT  — tags grouped by topic (click to select)
 *        RIGHT — details of selected tag
 */

import React, { useState, useEffect, useCallback, Fragment } from 'react';
import { INotebookTracker } from '@jupyterlab/notebook';

// ── JSON syntax highlighter (Python/One-Dark palette) ─────────────────────────

const J = {
  brace:   '#abb2bf',   // { } [ ] , :
  key:     '#61afef',   // "key"
  str:     '#98c379',   // "string value"
  num:     '#d19a66',   // 42 / 3.14
  kw:      '#c678dd',   // true / false / null
};

function JsonHighlight({ value }: { value: object }): React.ReactElement {
  const json   = JSON.stringify(value, null, 2);
  // Token regex: captures keys (string + colon), plain strings, keywords, numbers, punctuation
  const TOKEN  = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;

  while ((m = TOKEN.exec(json)) !== null) {
    // Plain text between tokens (whitespace / newlines)
    if (m.index > last) {
      nodes.push(<Fragment key={`t${idx++}`}>{json.slice(last, m.index)}</Fragment>);
    }
    if (m[1] && m[2] !== undefined) {
      // "key":
      nodes.push(<span key={`k${idx++}`} style={{ color: J.key }}>{m[1]}</span>);
      nodes.push(<span key={`c${idx++}`} style={{ color: J.brace }}>{m[2]}</span>);
    } else if (m[3]) {
      nodes.push(<span key={`s${idx++}`} style={{ color: J.str }}>{m[3]}</span>);
    } else if (m[4]) {
      nodes.push(<span key={`kw${idx++}`} style={{ color: J.kw }}>{m[4]}</span>);
    } else if (m[5]) {
      nodes.push(<span key={`n${idx++}`} style={{ color: J.num }}>{m[5]}</span>);
    } else if (m[6]) {
      nodes.push(<span key={`p${idx++}`} style={{ color: J.brace }}>{m[6]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < json.length) nodes.push(<Fragment key={`e${idx}`}>{json.slice(last)}</Fragment>);

  return <pre className="ds-tp-json-hl">{nodes}</pre>;
}

// ── Palette & colour helpers ──────────────────────────────────────────────────

export const TAG_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#6366f1',
];

export function tagColorAuto(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

// ── Built-in tag library (each tag carries an explicit topic key) ─────────────

export const BUILT_IN_TAG_DEFS: {
  category: string;
  tags: { value: string; topic: string; description: string }[];
}[] = [
  { category: 'ML Pipeline', tags: [
    { value: 'data-loading',        topic: 'ML Pipeline', description: 'Cells that load data from files, databases, or APIs.' },
    { value: 'preprocessing',       topic: 'ML Pipeline', description: 'Data cleaning, normalization, and transformation steps.' },
    { value: 'feature-engineering', topic: 'ML Pipeline', description: 'Feature creation, selection, and encoding.' },
    { value: 'training',            topic: 'ML Pipeline', description: 'Model training and fitting.' },
    { value: 'evaluation',          topic: 'ML Pipeline', description: 'Metrics, validation, and model assessment.' },
    { value: 'inference',           topic: 'ML Pipeline', description: 'Prediction or scoring on new data.' },
  ]},
  { category: 'Quality', tags: [
    { value: 'todo',           topic: 'Quality', description: 'Cell needs attention or further work.' },
    { value: 'reviewed',       topic: 'Quality', description: 'Cell has been reviewed and approved.' },
    { value: 'needs-refactor', topic: 'Quality', description: 'Works but the implementation should be improved.' },
    { value: 'slow',           topic: 'Quality', description: 'Computationally slow — candidate for optimization.' },
    { value: 'broken',         topic: 'Quality', description: 'Cell is broken or produces errors.' },
    { value: 'tested',         topic: 'Quality', description: 'Cell has been verified to produce correct output.' },
  ]},
  { category: 'Report', tags: [
    { value: 'report',         topic: 'Report', description: 'Output to include in an exported report.' },
    { value: 'figure',         topic: 'Report', description: 'Cell that generates a figure or chart.' },
    { value: 'table',          topic: 'Report', description: 'Cell that generates a table.' },
    { value: 'key-finding',    topic: 'Report', description: 'Contains an important result or insight.' },
    { value: 'report-exclude', topic: 'Report', description: 'Explicitly exclude from report output.' },
  ]},
  { category: 'Status', tags: [
    { value: 'draft',      topic: 'Status', description: 'Work in progress — not finalized.' },
    { value: 'stable',     topic: 'Status', description: 'Unlikely to change; safe dependency for other cells.' },
    { value: 'deprecated', topic: 'Status', description: 'No longer needed; kept for reference.' },
    { value: 'sensitive',  topic: 'Status', description: 'Contains sensitive data, credentials, or PII.' },
  ]},
];

export const BUILT_IN_TOPICS = BUILT_IN_TAG_DEFS.map(g => g.category);

// ── Custom tag store (localStorage) ──────────────────────────────────────────

const CUSTOM_TAGS_KEY = 'varys_custom_tag_definitions';

/** Tag JSON shape: { "value": string, "topic": string, "description": string, "color": string } */
export interface CustomTagDef {
  value:       string;
  topic:       string;   // required
  description: string;
  color?:      string;
}

export function loadCustomTags(): CustomTagDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TAGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    return parsed.map(r => ({
      value:       r['value'] ?? r['name'] ?? '',
      topic:       r['topic'] ?? 'Custom',        // migrate: default to Custom
      description: r['description'] ?? '',
      color:       r['color'],
    })).filter(t => t.value);
  } catch { return []; }
}

function saveCustomTagsToStorage(tags: CustomTagDef[]): void {
  localStorage.setItem(CUSTOM_TAGS_KEY, JSON.stringify(tags));
}

function resolveColor(tagValue: string, customTags: CustomTagDef[]): string {
  const custom = customTags.find(t => t.value === tagValue);
  return custom?.color ?? tagColorAuto(tagValue);
}

function findMeta(tagValue: string, customTags: CustomTagDef[]): { description: string; topic: string } {
  const custom = customTags.find(t => t.value === tagValue);
  if (custom) return { description: custom.description, topic: custom.topic };
  for (const group of BUILT_IN_TAG_DEFS) {
    const found = group.tags.find(t => t.value === tagValue);
    if (found) return { description: found.description, topic: found.topic };
  }
  return { description: '', topic: '' };
}

// ── ColorPicker ───────────────────────────────────────────────────────────────

const ColorPicker: React.FC<{ value: string; onChange: (c: string) => void }> = ({ value, onChange }) => (
  <div className="ds-tp-color-picker">
    {TAG_PALETTE.map(c => (
      <button
        key={c}
        className={`ds-tp-color-swatch${value === c ? ' ds-tp-color-swatch--active' : ''}`}
        style={{ background: c }}
        onClick={() => onChange(c)}
        title={c}
        type="button"
      />
    ))}
  </div>
);

// ── TagPill ───────────────────────────────────────────────────────────────────

const TagPill: React.FC<{
  tagValue: string; color: string;
  selected: boolean; onClick: () => void;
}> = ({ tagValue, color, selected, onClick }) => (
  <button
    className={`ds-tp-pill${selected ? ' ds-tp-pill--selected' : ''}`}
    style={{ '--pill-color': color } as React.CSSProperties}
    onClick={onClick}
    title={tagValue}
  >
    {tagValue}
  </button>
);

// ── Main component ────────────────────────────────────────────────────────────

export interface TagsPanelProps {
  notebookTracker: INotebookTracker;
}

export const TagsPanel: React.FC<TagsPanelProps> = ({ notebookTracker }) => {

  const [customTags,  setCustomTags]  = useState<CustomTagDef[]>(loadCustomTags);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Create form
  const [newValue, setNewValue] = useState('');
  const [newDesc,  setNewDesc]  = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [newColor, setNewColor] = useState(TAG_PALETTE[0]);
  const [nameErr,  setNameErr]  = useState('');

  // Edit mode (details panel)
  const [editMode,  setEditMode]  = useState(false);
  const [editDesc,  setEditDesc]  = useState('');
  const [editTopic, setEditTopic] = useState('');
  const [editColor, setEditColor] = useState(TAG_PALETTE[0]);

  // Keep in sync if Settings panel also writes custom tags
  const syncFromStorage = useCallback(() => { setCustomTags(loadCustomTags()); }, []);
  useEffect(() => {
    window.addEventListener('storage', syncFromStorage);
    return () => window.removeEventListener('storage', syncFromStorage);
  }, [syncFromStorage]);

  useEffect(() => {
    const noop = () => { /* keep alive */ };
    notebookTracker.currentChanged.connect(noop);
    return () => { notebookTracker.currentChanged.disconnect(noop); };
  }, [notebookTracker]);

  // ── All built-in values for duplicate check ───────────────────────────────
  const allBuiltInValues: string[] = ([] as string[]).concat(
    ...BUILT_IN_TAG_DEFS.map(g => g.tags.map(t => t.value))
  );

  // ── Create ────────────────────────────────────────────────────────────────
  const createTag = () => {
    const raw = newValue.trim().toLowerCase().replace(/\s+/g, '-');
    if (!raw)                                 { setNameErr('Value is required.'); return; }
    if (!/^[a-z0-9][\w\-.]*$/.test(raw))     { setNameErr('Only a-z, 0-9, - or _ allowed.'); return; }
    if (!newTopic)                            { setNameErr('Topic is required.'); return; }
    if (allBuiltInValues.includes(raw))       { setNameErr('Already a built-in tag.'); return; }
    if (customTags.some(t => t.value === raw)){ setNameErr('Custom tag already exists.'); return; }

    const tag: CustomTagDef = { value: raw, topic: newTopic, description: newDesc.trim(), color: newColor };
    const updated = [...customTags, tag];
    setCustomTags(updated);
    saveCustomTagsToStorage(updated);
    setNewValue(''); setNewDesc(''); setNewTopic(''); setNewColor(TAG_PALETTE[0]); setNameErr('');
    setSelectedTag(raw);
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const deleteCustomTag = (tagValue: string) => {
    const updated = customTags.filter(t => t.value !== tagValue);
    setCustomTags(updated);
    saveCustomTagsToStorage(updated);
    if (selectedTag === tagValue) setSelectedTag(null);
    setEditMode(false);
  };

  // ── Edit ──────────────────────────────────────────────────────────────────
  const beginEdit = (tag: CustomTagDef) => {
    setEditDesc(tag.description);
    setEditTopic(tag.topic);
    setEditColor(tag.color ?? tagColorAuto(tag.value));
    setEditMode(true);
  };

  const saveEdit = () => {
    if (!selectedTag) return;
    const updated = customTags.map(t =>
      t.value === selectedTag
        ? { ...t, description: editDesc.trim(), topic: editTopic, color: editColor }
        : t
    );
    setCustomTags(updated);
    saveCustomTagsToStorage(updated);
    setEditMode(false);
  };

  const cancelEdit = () => setEditMode(false);

  // Exit edit mode whenever selection changes
  useEffect(() => { setEditMode(false); }, [selectedTag]);

  // ── Selected tag meta ─────────────────────────────────────────────────────
  const isCustom = selectedTag ? customTags.some(t => t.value === selectedTag) : false;
  const selColor = selectedTag ? resolveColor(selectedTag, customTags) : TAG_PALETTE[0];
  const { description: selDesc, topic: selTopic } = selectedTag
    ? findMeta(selectedTag, customTags)
    : { description: '', topic: '' };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="ds-tags-panel ds-tags-panel-v2">

      {/* ── Create Tag: two-column (inputs | live JSON) ───────────────────── */}
      <div className="ds-tp-create-section">
        <div className="ds-tp-create-header">New Tag</div>

        <div className="ds-tp-create-body">

          {/* LEFT — inputs */}
          <div className="ds-tp-create-inputs">
            <input
              className="ds-tp-name-input"
              placeholder="tag-value"
              value={newValue}
              onChange={e => { setNewValue(e.target.value); setNameErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') createTag(); }}
            />
        <textarea
          className="ds-tp-desc-input"
          placeholder="Description"
          value={newDesc}
          rows={2}
          onChange={e => setNewDesc(e.target.value)}
        />
            <select
              className="ds-tp-topic-select"
              value={newTopic}
              onChange={e => setNewTopic(e.target.value)}
            >
              <option value="">— Topic —</option>
              {BUILT_IN_TOPICS.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <ColorPicker value={newColor} onChange={setNewColor} />
            {nameErr && <p className="ds-tp-error">{nameErr}</p>}
            <button
              className="ds-tp-create-btn"
              onClick={createTag}
              disabled={!newValue.trim() || !newTopic}
            >+ Create</button>
          </div>

          {/* RIGHT — live JSON preview */}
          <div className="ds-tp-create-preview">
            <div className="ds-tp-preview-label">Preview</div>
            <div className="ds-tp-preview-json">
              <JsonHighlight value={{
                value:       newValue.trim() || '…',
                topic:       newTopic       || '…',
                description: newDesc.trim() || '…',
                color:       newColor,
              }} />
            </div>
          </div>

        </div>
      </div>

      {/* ── Tag library: grouped list (left) + details (right) ───────────── */}
      <div className="ds-tp-library-header">Tag Library</div>
      <div className="ds-tp-body">

        {/* LEFT — grouped tag library */}
        <div className="ds-tp-list">
          {customTags.length > 0 && (
            <div className="ds-tp-group">
              <div className="ds-tp-group-label">Custom</div>
              <div className="ds-tp-group-pills">
                {customTags.map(t => (
                  <TagPill
                    key={t.value}
                    tagValue={t.value}
                    color={t.color ?? tagColorAuto(t.value)}
                    selected={selectedTag === t.value}
                    onClick={() => setSelectedTag(t.value)}
                  />
                ))}
              </div>
            </div>
          )}

          {BUILT_IN_TAG_DEFS.map(group => (
            <div key={group.category} className="ds-tp-group">
              <div className="ds-tp-group-label">{group.category}</div>
              <div className="ds-tp-group-pills">
                {group.tags.map(t => (
                  <TagPill
                    key={t.value}
                    tagValue={t.value}
                    color={tagColorAuto(t.value)}
                    selected={selectedTag === t.value}
                    onClick={() => setSelectedTag(t.value)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT — details panel */}
        <div className="ds-tp-details">
          {selectedTag ? (
            <>
              {/* Pill always visible */}
              <span
                className="ds-tp-details-pill"
                style={{ '--pill-color': editMode ? editColor : selColor } as React.CSSProperties}
              >{selectedTag}</span>

              {editMode ? (
                /* ── Edit mode ──────────────────────────────────────── */
                <>
                  <ColorPicker value={editColor} onChange={setEditColor} />

                  <input
                    className="ds-tp-edit-input"
                    placeholder="Description"
                    value={editDesc}
                    onChange={e => setEditDesc(e.target.value)}
                  />

                  <select
                    className="ds-tp-edit-select"
                    value={editTopic}
                    onChange={e => setEditTopic(e.target.value)}
                  >
                    <option value="">— Topic —</option>
                    {BUILT_IN_TOPICS.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>

                  <div className="ds-tp-edit-actions">
                    <button className="ds-tp-edit-save-btn"   onClick={saveEdit}>✓ Save</button>
                    <button className="ds-tp-edit-cancel-btn" onClick={cancelEdit}>✕</button>
                  </div>
                </>
              ) : (
                /* ── View mode ──────────────────────────────────────── */
                <>
                  <div className="ds-tp-details-color-row">
                    <span className="ds-tp-details-swatch" style={{ background: selColor }} />
                    <span className="ds-tp-details-hex">{selColor}</span>
                  </div>

                  <div className="ds-tp-details-json">
                    <JsonHighlight value={{ value: selectedTag, topic: selTopic, description: selDesc, color: selColor }} />
                  </div>

                  {selDesc ? (
                    <p className="ds-tp-details-desc">{selDesc}</p>
                  ) : (
                    <p className="ds-tp-details-desc ds-tp-details-desc--empty">No description.</p>
                  )}

                  {isCustom && (
                    <div className="ds-tp-details-actions">
                      <button
                        className="ds-tp-details-edit-btn"
                        onClick={() => beginEdit(customTags.find(t => t.value === selectedTag)!)}
                      >✎ Edit</button>
                      <button
                        className="ds-tp-details-del-btn"
                        onClick={() => deleteCustomTag(selectedTag)}
                      >🗑</button>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="ds-tp-details-hint">← Select a tag</p>
          )}
        </div>

      </div>
    </div>
  );
};
