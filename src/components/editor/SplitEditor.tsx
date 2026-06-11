import React, { useState } from 'react';
import CodeMirrorEditor from './CodeMirrorEditor';
import MarkdownPreview from './MarkdownPreview';
import './SplitEditor.css';

interface SplitEditorProps {
  value: string;
  onChange: (value: string) => void;
  filePath?: string;
}

export type EditorMode = 'edit' | 'preview' | 'split';

export const SplitEditor: React.FC<SplitEditorProps> = ({ value, onChange, filePath }) => {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [splitRatio, setSplitRatio] = useState(50); // 50% split by default

  const handleMouseMove = (e: React.MouseEvent) => {
    if ((e.buttons & 1) !== 1) return; // Only when left button is pressed
    
    const container = e.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();
    const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
    
    if (newRatio > 20 && newRatio < 80) {
      setSplitRatio(newRatio);
    }
  };

  return (
    <div className="split-editor-container">
      <div className="editor-mode-toolbar">
        <div className="mode-buttons">
          <button
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
            title="Edit mode"
          >
            ✏️ Edit
          </button>
          <button
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => setMode('preview')}
            title="Preview mode"
          >
            👁️ Preview
          </button>
          <button
            className={mode === 'split' ? 'active' : ''}
            onClick={() => setMode('split')}
            title="Split mode"
          >
            ⚡ Split
          </button>
        </div>
      </div>

      <div className={`editor-content editor-mode-${mode}`}>
        {mode === 'edit' && (
          <div className="editor-pane">
            <CodeMirrorEditor value={value} onChange={onChange} filePath={filePath} />
          </div>
        )}

        {mode === 'preview' && (
          <div className="preview-pane">
            <MarkdownPreview content={value} />
          </div>
        )}

        {mode === 'split' && (
          <div className="split-panes" onMouseMove={handleMouseMove}>
            <div
              className="editor-pane"
              style={{ width: `${splitRatio}%` }}
            >
              <CodeMirrorEditor value={value} onChange={onChange} filePath={filePath} />
            </div>

            <div className="split-divider" />

            <div
              className="preview-pane"
              style={{ width: `${100 - splitRatio}%` }}
            >
              <MarkdownPreview content={value} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
