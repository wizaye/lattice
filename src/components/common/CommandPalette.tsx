import React, { useEffect, useState, useCallback } from 'react';
import { IcSearch, IcFiles, IcEdit, IcGitBranch, IcSettings, IcCode } from '../common/Icons';
import './CommandPalette.css';

interface Command {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: 'file' | 'edit' | 'view' | 'git' | 'tools';
  icon?: React.ReactNode;
  handler: () => void | Promise<void>;
}

interface CommandPaletteProps {
  onClose: () => void;
}

const CATEGORIES = {
  file: { label: 'File', icon: <IcFiles /> },
  edit: { label: 'Edit', icon: <IcEdit /> },
  view: { label: 'View', icon: <IcCode /> },
  git: { label: 'Git', icon: <IcGitBranch /> },
  tools: { label: 'Tools', icon: <IcSettings /> },
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commands, setCommands] = useState<Command[]>([]);

  useEffect(() => {
    // Register available commands
    const allCommands: Command[] = [
      {
        id: 'file.new-note',
        label: 'New Note',
        description: 'Create a new note in inbox',
        shortcut: 'Ctrl+N',
        category: 'file',
        icon: <IcFiles />,
        handler: () => {
          console.log('New note');
          onClose();
        },
      },
      {
        id: 'file.quick-capture',
        label: 'Quick Capture',
        description: 'Create a quick note',
        shortcut: 'Ctrl+Q',
        category: 'file',
        handler: () => {
          console.log('Quick capture');
          onClose();
        },
      },
      {
        id: 'file.daily-note',
        label: 'Open Daily Note',
        description: 'Open or create today\'s daily note',
        category: 'file',
        handler: () => {
          console.log('Daily note');
          onClose();
        },
      },
      {
        id: 'edit.find',
        label: 'Find in Note',
        shortcut: 'Ctrl+F',
        category: 'edit',
        handler: () => {
          console.log('Find');
          onClose();
        },
      },
      {
        id: 'edit.replace',
        label: 'Find and Replace',
        shortcut: 'Ctrl+H',
        category: 'edit',
        handler: () => {
          console.log('Replace');
          onClose();
        },
      },
      {
        id: 'view.graph',
        label: 'Open Graph View',
        description: 'Visualize note connections',
        category: 'view',
        handler: () => {
          console.log('Graph view');
          onClose();
        },
      },
      {
        id: 'view.canvas',
        label: 'Open Canvas',
        description: 'Visual canvas for spatial notes',
        category: 'view',
        handler: () => {
          console.log('Canvas');
          onClose();
        },
      },
      {
        id: 'git.commit',
        label: 'Commit Changes',
        shortcut: 'Ctrl+Shift+C',
        category: 'git',
        handler: () => {
          console.log('Git commit');
          onClose();
        },
      },
      {
        id: 'git.push',
        label: 'Push to Remote',
        category: 'git',
        handler: () => {
          console.log('Git push');
          onClose();
        },
      },
      {
        id: 'tools.settings',
        label: 'Open Settings',
        shortcut: 'Ctrl+,',
        category: 'tools',
        handler: () => {
          console.log('Settings');
          onClose();
        },
      },
    ];

    setCommands(allCommands);
  }, [onClose]);

  const filteredCommands = commands.filter((cmd) => {
    const searchText = `${cmd.label} ${cmd.description || ''} ${cmd.category}`.toLowerCase();
    return searchText.includes(query.toLowerCase());
  });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          filteredCommands[selectedIndex].handler();
        }
      }
    },
    [onClose, filteredCommands, selectedIndex]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    // Reset selection when query changes
    setSelectedIndex(0);
  }, [query]);

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input">
          <IcSearch className="search-icon" />
          <input
            type="text"
            placeholder="Type a command or search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="command-palette-results">
          {filteredCommands.length === 0 ? (
            <div className="no-results">No commands found</div>
          ) : (
            filteredCommands.map((cmd, index) => (
              <div
                key={cmd.id}
                className={`command-item ${index === selectedIndex ? 'selected' : ''}`}
                onClick={() => cmd.handler()}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="command-icon">
                  {cmd.icon || CATEGORIES[cmd.category].icon}
                </div>
                <div className="command-content">
                  <div className="command-label">{cmd.label}</div>
                  {cmd.description && (
                    <div className="command-description">{cmd.description}</div>
                  )}
                </div>
                <div className="command-meta">
                  {cmd.shortcut && (
                    <span className="command-shortcut">{cmd.shortcut}</span>
                  )}
                  <span className="command-category">
                    {CATEGORIES[cmd.category].label}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <span>↑↓ Navigate</span>
          <span>↵ Execute</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
};
