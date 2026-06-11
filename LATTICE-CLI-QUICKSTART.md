# Quick Start Guide - Lattice CLI

## ✅ Installation Complete!

The `lattice` command is now available globally with **ratatui TUI interface**.

---

## Launch the CLI

**From any directory, just type:**

```powershell
lattice
```

This launches the **interactive TUI** with:
- Files browser
- Real-time search
- Keyboard navigation (j/k or arrows)
- Press `q` to quit

---

## Common Commands

```powershell
# Interactive TUI (default)
lattice
lattice open

# Quick info
lattice info
lattice stats

# Create notes
lattice new "Meeting Notes"
lattice quick "Quick thought"
lattice journal  # Today's entry

# Search
lattice search "keyword"
lattice list

# Specify vault
lattice --vault "C:\my-vault" stats
```

---

## Important Notes

### ⚠️ Current Session
In **this PowerShell window**, run this first:
```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")
```

### ✅ New Sessions
In **new terminal windows**, just type `lattice` - it will work automatically!

---

## Full Documentation

- `docs/CLI-INSTALLATION.md` - Complete installation guide
- `docs/CLI-DEV-GUIDE.md` - Development workflow
- `docs/COMPLETE-IMPLEMENTATION.md` - Technical details

---

## Try It Now!

**Option 1: Launch TUI (recommended)**
```powershell
lattice
# Press '1' for Files, '2' for Search, '?' for Help, 'q' to quit
```

**Option 2: Quick commands**
```powershell
lattice stats
lattice list
lattice search "test"
```

---

**Binary Location:** `C:\tools\lattice.exe`  
**Size:** 0.87 MB  
**Interface:** Ratatui TUI (terminal UI)

🚀 **Enjoy your standalone Lattice CLI!**
