#!/usr/bin/env node

/**
 * Lattice CLI - Enhanced commands for quick capture, daily notes, search, etc.
 */

const { invoke } = require('@tauri-apps/api/core');

const COMMANDS = {
  capture: {
    description: 'Quick capture text to inbox',
    usage: 'lattice capture "Your note text"',
    handler: async (args) => {
      const text = args.join(' ');
      if (!text) {
        console.error('Error: No text provided');
        process.exit(1);
      }

      try {
        const result = await invoke('create_note', {
          folder: 'inbox',
          title: null,
          content: text,
          tags: [],
        });
        console.log("✓ Created note: " + result.path);
      } catch (e) {
        console.error("Error: " + e);
        process.exit(1);
      }
    },
  },

  daily: {
    description: 'Open today\'s daily note',
    usage: 'lattice daily',
    handler: async () => {
      const today = new Date().toISOString().split('T')[0];
      const dailyPath = "Daily Notes/" + today + ".md";

      try {
        let note;
        try {
          note = await invoke('read_note', { relativePath: dailyPath });
        } catch {
          const template = "# " + today + "\n\n## Tasks\n\n- [ ] \n\n## Notes\n\n";
          note = await invoke('create_note', {
            folder: 'Daily Notes',
            title: today,
            content: template,
            tags: ['daily'],
          });
        }

        console.log("✓ Opened daily note: " + dailyPath);
      } catch (e) {
        console.error("Error: " + e);
        process.exit(1);
      }
    },
  },

  search: {
    description: 'Search notes for text',
    usage: 'lattice search "query"',
    handler: async (args) => {
      const query = args.join(' ');
      if (!query) {
        console.error('Error: No query provided');
        process.exit(1);
      }

      try {
        console.log("Searching for: \"" + query + "\"");
        console.log('(Search results would appear here)');
      } catch (e) {
        console.error("Error: " + e);
        process.exit(1);
      }
    },
  },

  tags: {
    description: 'List all tags in vault',
    usage: 'lattice tags',
    handler: async () => {
      try {
        const notes = await invoke('list_notes');
        const tagCounts = {};

        notes.forEach((note) => {
          note.tags.forEach((tag) => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        });

        const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

        console.log('Tags in vault:');
        sortedTags.forEach(([tag, count]) => {
          console.log("  #" + tag + " (" + count + " notes)");
        });
      } catch (e) {
        console.error("Error: " + e);
        process.exit(1);
      }
    },
  },

  backlinks: {
    description: 'Show backlinks for a note',
    usage: 'lattice backlinks "Note Name"',
    handler: async (args) => {
      const noteName = args.join(' ');
      if (!noteName) {
        console.error('Error: No note name provided');
        process.exit(1);
      }

      try {
        const backlinks = await invoke('get_backlinks', { noteName });

        if (backlinks.length === 0) {
          console.log("No backlinks found for \"" + noteName + "\"");
        } else {
          console.log("Backlinks to \"" + noteName + "\":");
          backlinks.forEach((link) => {
            console.log("  - " + link);
          });
        }
      } catch (e) {
        console.error("Error: " + e);
        process.exit(1);
      }
    },
  },
};

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === 'help' || command === '--help') {
    console.log('Lattice CLI - Quick note operations\n');
    console.log('Usage: lattice <command> [args]\n');
    console.log('Commands:');
    Object.entries(COMMANDS).forEach(([name, cmd]) => {
      console.log("  " + name.padEnd(12) + " - " + cmd.description);
      console.log("  " + ' '.repeat(12) + "   " + cmd.usage);
    });
    process.exit(0);
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error("Error: Unknown command \"" + command + "\"");
    console.error('Run "lattice help" for available commands');
    process.exit(1);
  }

  await cmd.handler(args);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
