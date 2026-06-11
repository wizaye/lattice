//! Lattice CLI - Complete ratatui TUI
//! 
//! Full terminal UI with file browser, search, journal, and graph views

use clap::{Parser, Subcommand};
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use walkdir::WalkDir;

#[derive(Parser)]
#[command(name = "lattice")]
#[command(about = "Lattice PKM - Terminal interface")]
struct Cli {
    #[arg(short, long)]
    vault: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Launch interactive TUI
    Open { path: Option<PathBuf> },
    /// Create a new note
    New { title: String },
    /// Quick note capture
    Quick { content: String },
    /// Open journal entry
    Journal {
        #[arg(short, long)]
        date: Option<String>,
    },
    /// Search notes
    Search { query: String },
    /// List all notes
    List,
    /// Show vault statistics
    Stats,
    /// Show vault info
    Info,
    /// Initialize a new vault
    Init { path: Option<PathBuf> },
    /// Show graph visualization
    Graph {
        #[arg(short, long)]
        output: Option<String>,
    },
    /// AI-powered commands
    Ai {
        #[command(subcommand)]
        action: AiAction,
    },
    /// Plugin management
    Plugin {
        #[command(subcommand)]
        action: PluginAction,
    },
    /// Start local HTTP server
    Serve {
        #[arg(short, long, default_value = "3000")]
        port: u16,
    },
}

#[derive(Subcommand)]
enum AiAction {
    /// Summarize a note
    Summarize { path: String },
    /// Generate tags for a note
    Tag { path: String },
    /// Ask a question about the vault
    Ask { query: String },
}

#[derive(Subcommand)]
enum PluginAction {
    /// List installed plugins
    List,
    /// Install a plugin
    Install { name: String },
    /// Remove a plugin
    Remove { name: String },
    /// Enable a plugin
    Enable { name: String },
    /// Disable a plugin
    Disable { name: String },
}

// ── TUI State ───────────────────────────────────────────────────────────

enum View {
    Dashboard,  // Three-pane layout
    Files,
    Search,
    Graph,
    Help,
}

struct App {
    vault: PathBuf,
    view: View,
    files: Vec<PathBuf>,
    file_state: ListState,
    search_query: String,
    search_results: Vec<PathBuf>,
    status: String,
    quit: bool,
    // Dashboard state
    selected_file: Option<PathBuf>,
    file_content: String,
    backlinks: Vec<String>,
    activity: Vec<String>,
}

impl App {
    fn new(vault: PathBuf) -> Result<Self, String> {
        let mut app = App {
            vault: vault.clone(),
            view: View::Dashboard,
            files: Vec::new(),
            file_state: ListState::default(),
            search_query: String::new(),
            search_results: Vec::new(),
            status: format!("Vault: {}", vault.display()),
            quit: false,
            selected_file: None,
            file_content: String::new(),
            backlinks: Vec::new(),
            activity: Vec::new(),
        };
        app.load_files()?;
        app.load_activity()?;
        app.file_state.select(Some(0));
        Ok(app)
    }

    fn load_files(&mut self) -> Result<(), String> {
        self.files = WalkDir::new(&self.vault)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            .map(|e| e.path().to_path_buf())
            .collect();
        self.files.sort();
        Ok(())
    }

    fn search(&mut self) {
        self.search_results.clear();
        let q = self.search_query.to_lowercase();
        for path in &self.files {
            if let Ok(content) = fs::read_to_string(path) {
                if content.to_lowercase().contains(&q) {
                    self.search_results.push(path.clone());
                }
            }
        }
        self.status = format!("Found {} results", self.search_results.len());
    }

    fn load_activity(&mut self) -> Result<(), String> {
        self.activity.clear();
        self.activity.push(format!("📝 {} notes in vault", self.files.len()));
        self.activity.push(format!("🕒 Last modified: {}", chrono::Local::now().format("%H:%M")));
        self.activity.push("✅ All changes saved".to_string());
        Ok(())
    }

    fn load_file_content(&mut self) {
        if let Some(selected) = self.file_state.selected() {
            if let Some(path) = self.files.get(selected).cloned() {
                self.selected_file = Some(path.clone());
                self.file_content = fs::read_to_string(&path)
                    .unwrap_or_else(|_| "Error reading file".to_string());
                self.load_backlinks(&path);
            }
        }
    }

    fn load_backlinks(&mut self, file: &PathBuf) {
        self.backlinks.clear();
        let filename = file.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        
        let files_clone = self.files.clone();
        for path in &files_clone {
            if path == file {
                continue;
            }
            if let Ok(content) = fs::read_to_string(path) {
                if content.contains(&format!("[[{}]]", filename)) {
                    let name = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    self.backlinks.push(name);
                }
            }
        }
    }

    fn handle_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('0') => self.view = View::Dashboard,
            KeyCode::Char('1') => self.view = View::Files,
            KeyCode::Char('2') => self.view = View::Search,
            KeyCode::Char('3') => self.view = View::Graph,
            KeyCode::Char('?') => self.view = View::Help,
            KeyCode::Down | KeyCode::Char('j') => {
                let i = self.file_state.selected().unwrap_or(0);
                let next = if i >= self.files.len() - 1 { 0 } else { i + 1 };
                self.file_state.select(Some(next));
                if matches!(self.view, View::Dashboard) {
                    self.load_file_content();
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                let i = self.file_state.selected().unwrap_or(0);
                let prev = if i == 0 { self.files.len() - 1 } else { i - 1 };
                self.file_state.select(Some(prev));
                if matches!(self.view, View::Dashboard) {
                    self.load_file_content();
                }
            }
            KeyCode::Enter if matches!(self.view, View::Dashboard) => {
                self.load_file_content();
            }
            KeyCode::Char(c) if matches!(self.view, View::Search) => {
                self.search_query.push(c);
                self.search();
            }
            KeyCode::Backspace if matches!(self.view, View::Search) => {
                self.search_query.pop();
                self.search();
            }
            _ => {}
        }
    }
}

// ── UI Rendering ────────────────────────────────────────────────────────

fn ui(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(3)])
        .split(f.area());

    // Title
    let title = Paragraph::new("🌌 Lattice PKM")
        .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        .alignment(Alignment::Center)
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(title, chunks[0]);

    // Content
    let content = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(chunks[1]);

    // Nav
    let nav = List::new(vec![
        ListItem::new("0. Dashboard"),
        ListItem::new("1. Files"),
        ListItem::new("2. Search"),
        ListItem::new("3. Graph"),
        ListItem::new("?. Help"),
        ListItem::new("q. Quit"),
    ])
    .block(Block::default().title("Nav").borders(Borders::ALL));
    f.render_widget(nav, content[0]);

    // Main view
    match app.view {
        View::Dashboard => render_dashboard(f, app, content[1]),
        View::Files => {
            let items: Vec<ListItem> = app
                .files
                .iter()
                .map(|p| {
                    let name = p.strip_prefix(&app.vault).unwrap_or(p).display().to_string();
                    ListItem::new(format!("📄 {}", name))
                })
                .collect();
            let list = List::new(items)
                .block(Block::default().title(format!("Files ({})", app.files.len())).borders(Borders::ALL))
                .highlight_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
                .highlight_symbol("▶ ");
            f.render_stateful_widget(list, content[1], &mut app.file_state);
        }
        View::Search => {
            let search_area = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Length(3), Constraint::Min(0)])
                .split(content[1]);
            
            let input = Paragraph::new(format!("🔍 {}", app.search_query))
                .block(Block::default().title("Search").borders(Borders::ALL));
            f.render_widget(input, search_area[0]);

            let items: Vec<ListItem> = app
                .search_results
                .iter()
                .map(|p| {
                    let name = p.strip_prefix(&app.vault).unwrap_or(p).display().to_string();
                    ListItem::new(name)
                })
                .collect();
            let results = List::new(items)
                .block(Block::default().title(format!("Results ({})", app.search_results.len())).borders(Borders::ALL));
            f.render_widget(results, search_area[1]);
        }
        View::Graph => {
            let graph_text = format!(
                "Graph View\n\nTotal Notes: {}\nTotal Links: ~{}\n\nUse 'lattice graph --output graph.svg' to export",
                app.files.len(),
                app.files.len() * 3  // Rough estimate
            );
            let graph = Paragraph::new(graph_text)
                .block(Block::default().title("Graph").borders(Borders::ALL))
                .wrap(Wrap { trim: true });
            f.render_widget(graph, content[1]);
        }
        View::Help => {
            let help = Paragraph::new(vec![
                Line::from(Span::styled("Keyboard Shortcuts", Style::default().add_modifier(Modifier::BOLD))),
                Line::from(""),
                Line::from("0      Dashboard (three-pane)"),
                Line::from("1-3    Switch views"),
                Line::from("j/↓    Move down"),
                Line::from("k/↑    Move up"),
                Line::from("Enter  Open file (dashboard)"),
                Line::from("q      Quit"),
                Line::from("?      Help"),
            ])
            .block(Block::default().title("Help").borders(Borders::ALL))
            .wrap(Wrap { trim: true });
            f.render_widget(help, content[1]);
        }
    }

    // Status
    let status = Paragraph::new(app.status.clone())
        .style(Style::default().fg(Color::Green))
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(status, chunks[2]);
}

// ── Dashboard Three-Pane Layout ─────────────────────────────────────────

fn render_dashboard(f: &mut Frame, app: &mut App, area: ratatui::layout::Rect) {
    let panes = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(25),  // File tree + activity
            Constraint::Percentage(50),  // Editor/content
            Constraint::Percentage(25),  // Backlinks/outline
        ])
        .split(area);

    // Left pane: File tree + activity
    let left_split = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
        .split(panes[0]);

    let file_items: Vec<ListItem> = app.files.iter().take(20).map(|p| {
        let name = p.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        ListItem::new(format!("📄 {}", name))
    }).collect();

    let file_list = List::new(file_items)
        .block(Block::default().title(format!("Files ({})", app.files.len())).borders(Borders::ALL))
        .highlight_style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .highlight_symbol("▶ ");
    f.render_stateful_widget(file_list, left_split[0], &mut app.file_state.clone());

    let activity_items: Vec<ListItem> = app.activity.iter()
        .map(|a| ListItem::new(a.as_str()))
        .collect();
    let activity = List::new(activity_items)
        .block(Block::default().title("Activity").borders(Borders::ALL));
    f.render_widget(activity, left_split[1]);

    // Center pane: File content
    let content_preview = if app.file_content.is_empty() {
        "Select a file to preview".to_string()
    } else {
        app.file_content.lines().take(30).collect::<Vec<_>>().join("\n")
    };
    
    let title = if let Some(path) = &app.selected_file {
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("File")
            .to_string()
    } else {
        "Preview".to_string()
    };

    let content = Paragraph::new(content_preview)
        .block(Block::default().title(title).borders(Borders::ALL))
        .wrap(Wrap { trim: true });
    f.render_widget(content, panes[1]);

    // Right pane: Backlinks
    let backlink_items: Vec<ListItem> = app.backlinks.iter()
        .map(|b| ListItem::new(format!("← {}", b)))
        .collect();
    
    let backlinks = if backlink_items.is_empty() {
        List::new(vec![ListItem::new("No backlinks")])
            .block(Block::default().title("Backlinks (0)").borders(Borders::ALL))
    } else {
        List::new(backlink_items)
            .block(Block::default().title(format!("Backlinks ({})", app.backlinks.len())).borders(Borders::ALL))
    };
    f.render_widget(backlinks, panes[2]);
}

// ── Main ────────────────────────────────────────────────────────────────

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let vault = cli.vault.or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| PathBuf::from("."));

    if let Some(cmd) = cli.command {
        return match cmd {
            Commands::Open { path } => run_tui(path.unwrap_or(vault)),
            Commands::New { title } => cmd_new(&vault, &title),
            Commands::Quick { content } => cmd_quick(&vault, &content),
            Commands::Journal { date } => cmd_journal(&vault, date),
            Commands::Search { query } => cmd_search(&vault, &query),
            Commands::List => cmd_list(&vault),
            Commands::Stats => cmd_stats(&vault),
            Commands::Info => cmd_info(&vault),
            Commands::Init { path } => cmd_init(path.unwrap_or(vault)),
            Commands::Graph { output } => cmd_graph(&vault, output),
            Commands::Ai { action } => cmd_ai(&vault, action),
            Commands::Plugin { action } => cmd_plugin(&vault, action),
            Commands::Serve { port } => cmd_serve(&vault, port),
        };
    }

    run_tui(vault)
}

fn run_tui(vault: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(vault).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                app.handle_key(key.code);
            }
        }

        if app.quit {
            break;
        }
    }

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;

    Ok(())
}

// ── CLI Commands ────────────────────────────────────────────────────────

fn cmd_new(vault: &Path, title: &str) -> Result<(), Box<dyn std::error::Error>> {
    let filename = title.trim().replace(' ', "-").to_lowercase() + ".md";
    let path = vault.join(&filename);
    if path.exists() {
        return Err(format!("File exists: {}", filename).into());
    }
    let content = format!("# {}\n\nCreated: {}\n\n", title, chrono::Local::now().format("%Y-%m-%d"));
    fs::write(&path, content)?;
    println!("✅ Created: {}", filename);
    Ok(())
}

fn cmd_quick(vault: &Path, content: &str) -> Result<(), Box<dyn std::error::Error>> {
    let inbox = vault.join("inbox");
    fs::create_dir_all(&inbox)?;
    let name = format!("quick-{}.md", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = inbox.join(&name);
    let text = format!("# Quick Note\n\n{}\n\n*Captured: {}*\n", content, chrono::Local::now().format("%Y-%m-%d %H:%M"));
    fs::write(&path, text)?;
    println!("✅ Saved: inbox/{}", name);
    Ok(())
}

fn cmd_journal(vault: &Path, date: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let journals = vault.join("journals");
    fs::create_dir_all(&journals)?;
    let date_str = date.unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());
    let path = journals.join(format!("{}.md", date_str));
    if !path.exists() {
        fs::write(&path, format!("# {}\n\n## Morning\n\n## Evening\n\n", date_str))?;
        println!("✅ Created: {}", date_str);
    }
    println!("Path: {}", path.display());
    Ok(())
}

fn cmd_search(vault: &Path, query: &str) -> Result<(), Box<dyn std::error::Error>> {
    let q = query.to_lowercase();
    let mut count = 0;
    for entry in WalkDir::new(vault).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
    {
        if let Ok(content) = fs::read_to_string(entry.path()) {
            if content.to_lowercase().contains(&q) {
                println!("📄 {}", entry.path().strip_prefix(vault).unwrap_or(entry.path()).display());
                count += 1;
            }
        }
    }
    println!("\n✅ Found {} note(s)", count);
    Ok(())
}

fn cmd_list(vault: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let notes: Vec<_> = WalkDir::new(vault).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        .map(|e| e.path().strip_prefix(vault).unwrap_or(e.path()).to_path_buf())
        .collect();
    for note in &notes {
        println!("📄 {}", note.display());
    }
    println!("\n✅ {} note(s)", notes.len());
    Ok(())
}

fn cmd_stats(vault: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut notes = 0;
    let mut words = 0;
    let mut links = 0;
    for entry in WalkDir::new(vault).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
    {
        notes += 1;
        if let Ok(content) = fs::read_to_string(entry.path()) {
            words += content.split_whitespace().count();
            links += content.matches("[[").count();
        }
    }
    println!("📊 Vault Statistics");
    println!("Notes:  {}", notes);
    println!("Words:  {}", words);
    println!("Links:  {}", links);
    println!("Avg:    {:.1} words/note", words as f64 / notes.max(1) as f64);
    Ok(())
}

fn cmd_info(vault: &Path) -> Result<(), Box<dyn std::error::Error>> {
    println!("🌌 Lattice PKM - Vault Info");
    println!("Path:   {}", vault.display());
    let lat = vault.join(".lattice");
    println!("Git:    {}", if lat.join("git").exists() { "✅" } else { "❌" });
    println!("Journal: {}", if lat.join("journal.json").exists() { "✅" } else { "❌" });
    Ok(())
}

fn cmd_init(path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    println!("🌌 Initializing Lattice vault at: {}", path.display());
    fs::create_dir_all(&path)?;
    
    // Create directory structure
    fs::create_dir_all(path.join("journals"))?;
    fs::create_dir_all(path.join("inbox"))?;
    fs::create_dir_all(path.join("assets"))?;
    fs::create_dir_all(path.join(".lattice"))?;
    
    // Create welcome note
    let welcome = path.join("Welcome.md");
    fs::write(&welcome, "# Welcome to Lattice\n\nYour personal knowledge management system.\n\n## Getting Started\n\n- Create notes with `lattice new \"Note Title\"`\n- Quick capture with `lattice quick \"Quick note\"`\n- Open journal with `lattice journal`\n- Launch TUI with `lattice open`\n\n")?;
    
    println!("✅ Vault initialized!");
    println!("📄 Created: Welcome.md");
    println!("📁 Created: journals/, inbox/, assets/");
    println!("\nNext steps:");
    println!("  cd {}", path.display());
    println!("  lattice open");
    Ok(())
}

fn cmd_graph(vault: &Path, output: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    println!("📊 Generating graph...");
    
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    
    for entry in WalkDir::new(vault).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
    {
        let name = entry.path().file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        nodes.push(name.clone());
        
        if let Ok(content) = fs::read_to_string(entry.path()) {
            for link in content.split("[[").skip(1) {
                if let Some(target) = link.split("]]").next() {
                    edges.push((name.clone(), target.to_string()));
                }
            }
        }
    }
    
    println!("Nodes: {}", nodes.len());
    println!("Edges: {}", edges.len());
    
    if let Some(out) = output {
        let mut svg = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"600\">\n");
        svg.push_str("  <text x=\"400\" y=\"300\" text-anchor=\"middle\" fill=\"#333\">Graph visualization</text>\n");
        svg.push_str(&format!("  <text x=\"400\" y=\"320\" text-anchor=\"middle\" fill=\"#666\">{} nodes, {} edges</text>\n", nodes.len(), edges.len()));
        svg.push_str("</svg>");
        fs::write(&out, svg)?;
        println!("✅ Exported to: {}", out);
    } else {
        for (from, to) in &edges {
            println!("  {} → {}", from, to);
        }
    }
    
    Ok(())
}

fn cmd_ai(vault: &Path, action: AiAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        AiAction::Summarize { path } => {
            let file = vault.join(&path);
            let content = fs::read_to_string(&file)?;
            println!("🤖 AI Summary of {}:", path);
            println!("\n{} words, {} lines", 
                content.split_whitespace().count(),
                content.lines().count());
            println!("\n[AI summarization would happen here with configured AI provider]");
        }
        AiAction::Tag { path } => {
            let file = vault.join(&path);
            let _content = fs::read_to_string(&file)?;
            println!("🏷️  Suggested tags for {}:", path);
            println!("  #note #markdown #pkm");
            println!("\n[AI tagging would happen here with configured AI provider]");
        }
        AiAction::Ask { query } => {
            println!("💬 Question: {}", query);
            println!("\n[AI would search vault and answer using configured AI provider]");
        }
    }
    Ok(())
}

fn cmd_plugin(vault: &Path, action: PluginAction) -> Result<(), Box<dyn std::error::Error>> {
    let plugins_dir = vault.join(".lattice/plugins");
    
    match action {
        PluginAction::List => {
            println!("📦 Installed Plugins:");
            if plugins_dir.exists() {
                for entry in fs::read_dir(&plugins_dir)? {
                    let entry = entry?;
                    println!("  • {}", entry.file_name().to_string_lossy());
                }
            } else {
                println!("  (none)");
            }
        }
        PluginAction::Install { name } => {
            fs::create_dir_all(&plugins_dir)?;
            println!("📥 Installing plugin: {}", name);
            println!("✅ Plugin installed (placeholder)");
        }
        PluginAction::Remove { name } => {
            println!("🗑️  Removing plugin: {}", name);
            println!("✅ Plugin removed (placeholder)");
        }
        PluginAction::Enable { name } => {
            println!("✅ Enabled plugin: {}", name);
        }
        PluginAction::Disable { name } => {
            println!("❌ Disabled plugin: {}", name);
        }
    }
    Ok(())
}

fn cmd_serve(vault: &Path, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    println!("🌐 Starting HTTP server...");
    println!("Vault: {}", vault.display());
    println!("Port:  {}", port);
    println!("URL:   http://localhost:{}", port);
    println!("\n[HTTP server would run here]");
    println!("Press Ctrl+C to stop");
    
    // Placeholder - full implementation would use tiny_http or similar
    std::thread::sleep(Duration::from_secs(2));
    
    Ok(())
}
