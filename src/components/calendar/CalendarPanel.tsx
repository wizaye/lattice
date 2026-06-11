/**
 * v2 §1.5 — Calendar panel (left-sidebar view).
 *
 * ## What ships in this slice
 *
 * - Day / Week / Month view switcher (sidebar-sized — see CSS).
 * - Event grid rendered from `useCalendarStore.events` (local + future
 *   provider events use the same shape).
 * - "Today" section embeds the journal entry CTA (§2.3) + streak
 *   badge so the calendar surface IS the daily-notes surface.
 * - "+ New event" → opens [`EventDialog`] (local-only writes today).
 *
 * ## What's deferred
 *
 * - The §2.2 outliner mode for journal files — ships in a follow-up
 *   slice that touches the editor, not the calendar.
 * - Provider connect UI lives in Settings → Calendar (separate sheet),
 *   not in this panel.
 *
 * ## Layout choices
 *
 * The left sidebar is narrow (~280px), so:
 * - Day view = vertical agenda (timeline-style chips).
 * - Week view = 7 stacked rows (one per day) with chips inside —
 *   NOT a 7×24 grid (illegible at this width).
 * - Month view = classic 6×7 mini-grid with event dots; clicking a
 *   cell promotes that day into the Day view automatically.
 *
 * If the user later docks the calendar to the main editor pane (out
 * of scope), the same component can adopt a wider layout by reading
 * its container width.  For now we just optimise for the sidebar.
 */

import { useEffect, useMemo, useState } from "react";

import {
  useCalendarStore,
  type CalEvent,
  type CalViewMode,
} from "../../state/calendarStore";
import { useJournalStore } from "../../state/journalStore";
import { useVaultStore } from "../../state/vaultStore";
import { IcCalendar, IcEdit, IcPlus, IcSparkle, IcTrash } from "../common/Icons";

import { EventDialog } from "./EventDialog";
import "./CalendarPanel.css";

type Props = {
  /**
   * Called when the user clicks "Open today's journal" or an event
   * whose `note_path` resolves to a real file in the vault.  Routed
   * back to App.tsx so existing tab-opening logic owns the tabs.
   */
  onOpenFileByPath: (path: string) => void;
};

// ── Date helpers ────────────────────────────────────────────────────────

/** `YYYY-MM-DD` from a JS `Date` in LOCAL time (not UTC). */
function toLocalIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse `YYYY-MM-DD` as a local-midnight `Date`. */
function fromLocalIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Sunday of the week containing `date`, as a local-midnight `Date`. */
function startOfWeek(date: Date): Date {
  const out = new Date(date);
  out.setDate(out.getDate() - out.getDay());
  out.setHours(0, 0, 0, 0);
  return out;
}

/** First day of the month containing `date`. */
function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** First day of the NEXT month. */
function startOfNextMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

/** Compute the `[from, to)` UTC ISO window for the current view. */
function viewWindow(viewMode: CalViewMode, selectedIso: string): {
  fromIso: string;
  toIso: string;
} {
  const selected = fromLocalIso(selectedIso);
  if (viewMode === "day") {
    const from = new Date(selected);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { fromIso: from.toISOString(), toIso: to.toISOString() };
  }
  if (viewMode === "week") {
    const from = startOfWeek(selected);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { fromIso: from.toISOString(), toIso: to.toISOString() };
  }
  // month: pad by one week on either side so the 6×7 grid is fully covered.
  const monthStart = startOfMonth(selected);
  const monthEnd = startOfNextMonth(selected);
  const from = new Date(monthStart);
  from.setDate(from.getDate() - 7);
  const to = new Date(monthEnd);
  to.setDate(to.getDate() + 7);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** Group events by their `YYYY-MM-DD` local-date string. */
function groupEventsByDay(events: CalEvent[]): Map<string, CalEvent[]> {
  const out = new Map<string, CalEvent[]>();
  for (const ev of events) {
    const key = toLocalIso(new Date(ev.start));
    const slot = out.get(key);
    if (slot) slot.push(ev);
    else out.set(key, [ev]);
  }
  return out;
}

/** Render an event time range like "9:00 – 9:30" in the local zone. */
function formatRange(startIso: string, endIso: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const start = new Date(startIso).toLocaleTimeString(undefined, opts);
  const end = new Date(endIso).toLocaleTimeString(undefined, opts);
  return `${start} – ${end}`;
}

/** Color class for an event chip based on its source. */
function sourceClass(source: CalEvent["source"]): string {
  return `cal-chip-${source}`;
}

// ── Component ──────────────────────────────────────────────────────────

export function CalendarPanel({ onOpenFileByPath }: Props) {
  const vaultPath = useVaultStore((s) => s.vaultPath);

  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const viewMode = useCalendarStore((s) => s.viewMode);
  const events = useCalendarStore((s) => s.events);
  const loading = useCalendarStore((s) => s.loading);
  const error = useCalendarStore((s) => s.error);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const setViewMode = useCalendarStore((s) => s.setViewMode);
  const refreshEvents = useCalendarStore((s) => s.refreshEvents);
  const refreshProviders = useCalendarStore((s) => s.refreshProviders);
  const deleteEvent = useCalendarStore((s) => s.deleteEvent);

  const journalStreak = useJournalStore((s) => s.streak);
  const refreshJournal = useJournalStore((s) => s.refresh);
  const openTodayJournal = useJournalStore((s) => s.openToday);
  const openDateJournal = useJournalStore((s) => s.openDate);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalEvent | null>(null);

  // Refresh on mount and whenever the visible window changes.  We
  // deliberately re-fetch on every viewMode / selectedDate change
  // instead of pre-caching wider windows — this slice's storage is a
  // JSON file (cheap reads) and we get strict freshness for free.
  useEffect(() => {
    if (!vaultPath || vaultPath === "__mock__") return;
    const { fromIso, toIso } = viewWindow(viewMode, selectedDate);
    void refreshEvents(vaultPath, fromIso, toIso);
  }, [vaultPath, viewMode, selectedDate, refreshEvents]);

  // Provider manifest + journal are sidebar-static metadata — pull
  // them once on mount and once on vault change.
  useEffect(() => {
    if (!vaultPath || vaultPath === "__mock__") return;
    void refreshProviders(vaultPath);
    void refreshJournal(vaultPath);
  }, [vaultPath, refreshProviders, refreshJournal]);

  const eventsByDay = useMemo(() => groupEventsByDay(events), [events]);
  const todayIso = useMemo(() => toLocalIso(new Date()), []);
  const todaysEvents = eventsByDay.get(todayIso) ?? [];

  const noVault = !vaultPath || vaultPath === "__mock__";

  return (
    <div className="cal-panel">
      {/* ── Header: view switcher + Today + new event ── */}
      <div className="cal-toolbar">
        <div className="cal-view-switch" role="tablist" aria-label="Calendar view">
          {(["day", "week", "month"] as const).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={viewMode === mode}
              className={`cal-view-btn${viewMode === mode ? " active" : ""}`}
              onClick={() => setViewMode(mode)}
            >
              {mode[0].toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <button
          className="cal-today-btn"
          title="Jump to today"
          onClick={() => setSelectedDate(todayIso)}
        >
          Today
        </button>
        <button
          className="icon-btn tiny"
          title="New event"
          aria-label="New event"
          disabled={noVault}
          onClick={() => {
            setEditingEvent(null);
            setDialogOpen(true);
          }}
        >
          <IcPlus />
        </button>
      </div>

      {/* ── Date label ── */}
      <div className="cal-date-label">
        <IcCalendar />
        <span>{formatViewLabel(viewMode, selectedDate)}</span>
      </div>

      {/* ── Body: view-specific render ── */}
      <div className="cal-body">
        {error && <div className="cal-error">{error}</div>}
        {loading && !events.length && <div className="cal-empty">Loading…</div>}
        {noVault && (
          <div className="cal-empty">Open a vault to see your calendar.</div>
        )}
        {!noVault && viewMode === "day" && (
          <DayView
            iso={selectedDate}
            events={eventsByDay.get(selectedDate) ?? []}
            onEdit={(ev) => {
              setEditingEvent(ev);
              setDialogOpen(true);
            }}
            onDelete={(ev) => {
              if (vaultPath) void deleteEvent(vaultPath, ev.id);
            }}
            onOpenNote={(path) => onOpenFileByPath(path)}
          />
        )}
        {!noVault && viewMode === "week" && (
          <WeekView
            anchorIso={selectedDate}
            eventsByDay={eventsByDay}
            onSelectDay={(iso) => {
              setSelectedDate(iso);
              setViewMode("day");
            }}
            onCreateJournal={async (iso) => {
              if (!vaultPath) return;
              try {
                const result = await openDateJournal(vaultPath, iso);
                await useVaultStore.getState().refreshTree();
                onOpenFileByPath(result.path);
              } catch (err) {
                console.error("[calendar] openDateJournal failed:", err);
              }
            }}
          />
        )}
        {!noVault && viewMode === "month" && (
          <MonthView
            anchorIso={selectedDate}
            todayIso={todayIso}
            eventsByDay={eventsByDay}
            onSelectDay={(iso) => {
              setSelectedDate(iso);
              setViewMode("day");
            }}
            onCreateJournal={async (iso) => {
              if (!vaultPath) return;
              try {
                const result = await openDateJournal(vaultPath, iso);
                await useVaultStore.getState().refreshTree();
                onOpenFileByPath(result.path);
              } catch (err) {
                console.error("[calendar] openDateJournal failed:", err);
              }
            }}
          />
        )}
      </div>

      {/* ── Today section: journal CTA + streak + agenda ── */}
      <div className="cal-today-card">
        <div className="cal-today-head">
          <span>Today</span>
          {journalStreak && journalStreak.current > 0 && (
            <span
              className="cal-streak"
              title={`Longest streak: ${journalStreak.longest} day${journalStreak.longest === 1 ? "" : "s"}`}
            >
              <IcSparkle /> {journalStreak.current} day
              {journalStreak.current === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <button
          className="cal-journal-btn"
          disabled={noVault}
          onClick={async () => {
            if (!vaultPath) return;
            try {
              const result = await openTodayJournal(vaultPath);
              // Refresh vault tree so the new file appears in the
              // file pane.  We import lazily to avoid a tighter
              // coupling between calendar and vault subscriptions.
              await useVaultStore.getState().refreshTree();
              onOpenFileByPath(result.path);
            } catch (err) {
              console.error("[calendar] openTodayJournal failed:", err);
            }
          }}
        >
          <IcEdit /> Open today’s journal
        </button>
        {todaysEvents.length === 0 ? (
          <div className="cal-empty cal-empty-soft">No events today.</div>
        ) : (
          <ul className="cal-agenda">
            {todaysEvents.map((ev) => (
              <li key={ev.id} className={`cal-agenda-item ${sourceClass(ev.source)}`}>
                <span className="cal-agenda-time">
                  {formatRange(ev.start, ev.end)}
                </span>
                <span className="cal-agenda-title">{ev.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialogOpen && vaultPath && (
        <EventDialog
          vaultPath={vaultPath}
          initialDate={selectedDate}
          existing={editingEvent}
          onClose={() => {
            setDialogOpen(false);
            setEditingEvent(null);
          }}
        />
      )}
    </div>
  );
}

// ── Sub-views ──────────────────────────────────────────────────────────

function DayView({
  iso,
  events,
  onEdit,
  onDelete,
  onOpenNote,
}: {
  iso: string;
  events: CalEvent[];
  onEdit: (ev: CalEvent) => void;
  onDelete: (ev: CalEvent) => void;
  onOpenNote: (path: string) => void;
}) {
  const dateLabel = useMemo(() => {
    const d = fromLocalIso(iso);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [iso]);

  if (events.length === 0) {
    return (
      <div className="cal-day">
        <div className="cal-day-head">{dateLabel}</div>
        <div className="cal-empty cal-empty-soft">Nothing scheduled.</div>
      </div>
    );
  }
  return (
    <div className="cal-day">
      <div className="cal-day-head">{dateLabel}</div>
      <ul className="cal-day-list">
        {events.map((ev) => (
          <li key={ev.id} className={`cal-event ${sourceClass(ev.source)}`}>
            <div className="cal-event-row">
              <span className="cal-event-time">
                {formatRange(ev.start, ev.end)}
              </span>
              <div className="cal-event-actions">
                {ev.note_path && (
                  <button
                    className="icon-btn tiny"
                    title="Open linked note"
                    onClick={() => ev.note_path && onOpenNote(ev.note_path)}
                  >
                    <IcEdit />
                  </button>
                )}
                {ev.source === "local" && (
                  <>
                    <button
                      className="icon-btn tiny"
                      title="Edit event"
                      onClick={() => onEdit(ev)}
                    >
                      <IcEdit />
                    </button>
                    <button
                      className="icon-btn tiny"
                      title="Delete event"
                      onClick={() => onDelete(ev)}
                    >
                      <IcTrash />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="cal-event-title">{ev.title}</div>
            {ev.attendees.length > 0 && (
              <div className="cal-event-attendees">
                {ev.attendees.join(", ")}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WeekView({
  anchorIso,
  eventsByDay,
  onSelectDay,
  onCreateJournal,
}: {
  anchorIso: string;
  eventsByDay: Map<string, CalEvent[]>;
  onSelectDay: (iso: string) => void;
  onCreateJournal: (iso: string) => void | Promise<void>;
}) {
  const days = useMemo(() => {
    const start = startOfWeek(fromLocalIso(anchorIso));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [anchorIso]);

  return (
    <ul className="cal-week">
      {days.map((d) => {
        const iso = toLocalIso(d);
        const dayEvents = eventsByDay.get(iso) ?? [];
        const isAnchor = iso === anchorIso;
        return (
          <li
            key={iso}
            className={`cal-week-row${isAnchor ? " active" : ""}`}
            onClick={() => onSelectDay(iso)}
            onContextMenu={(e) => {
              e.preventDefault();
              onCreateJournal(iso);
            }}
            title="Click to open day • Right-click to open/create journal"
          >
            <div className="cal-week-date">
              <div className="cal-week-dow">
                {d.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div className="cal-week-day">{d.getDate()}</div>
            </div>
            <div className="cal-week-events">
              {dayEvents.length === 0 ? (
                <span className="cal-empty-soft">—</span>
              ) : (
                dayEvents.slice(0, 3).map((ev) => (
                  <span
                    key={ev.id}
                    className={`cal-week-chip ${sourceClass(ev.source)}`}
                    title={`${formatRange(ev.start, ev.end)} — ${ev.title}`}
                  >
                    {ev.title}
                  </span>
                ))
              )}
              {dayEvents.length > 3 && (
                <span className="cal-week-more">+{dayEvents.length - 3}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MonthView({
  anchorIso,
  todayIso,
  eventsByDay,
  onSelectDay,
  onCreateJournal,
}: {
  anchorIso: string;
  todayIso: string;
  eventsByDay: Map<string, CalEvent[]>;
  onSelectDay: (iso: string) => void;
  onCreateJournal: (iso: string) => void | Promise<void>;
}) {
  const anchor = fromLocalIso(anchorIso);
  // 6×7 grid starting on the Sunday on/before the 1st.
  const cells = useMemo(() => {
    const monthStart = startOfMonth(anchor);
    const gridStart = startOfWeek(monthStart);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [anchor]);

  const monthIdx = anchor.getMonth();
  const dows = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="cal-month">
      <div className="cal-month-dow-row">
        {dows.map((d, i) => (
          <div key={i} className="cal-month-dow">
            {d}
          </div>
        ))}
      </div>
      <div className="cal-month-grid">
        {cells.map((d) => {
          const iso = toLocalIso(d);
          const dayEvents = eventsByDay.get(iso) ?? [];
          const isCurrentMonth = d.getMonth() === monthIdx;
          const isAnchor = iso === anchorIso;
          const isToday = iso === todayIso;
          return (
            <button
              key={iso}
              className={`cal-month-cell${
                isCurrentMonth ? "" : " muted"
              }${isAnchor ? " active" : ""}${isToday ? " today" : ""}`}
              onClick={() => onSelectDay(iso)}
              onContextMenu={(e) => {
                e.preventDefault();
                onCreateJournal(iso);
              }}
              title={
                dayEvents.length === 0
                  ? "No events • Right-click to open/create journal"
                  : `${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"} • Right-click to open/create journal`
              }
            >
              <span className="cal-month-num">{d.getDate()}</span>
              {dayEvents.length > 0 && (
                <span className="cal-month-dots">
                  {dayEvents.slice(0, 3).map((ev) => (
                    <span
                      key={ev.id}
                      className={`cal-month-dot ${sourceClass(ev.source)}`}
                    />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Label helper ───────────────────────────────────────────────────────

function formatViewLabel(view: CalViewMode, iso: string): string {
  const d = fromLocalIso(iso);
  if (view === "day") {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const start = startOfWeek(d);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    if (sameMonth) {
      return `${start.toLocaleDateString(undefined, { month: "short" })} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${end.getFullYear()}`;
  }
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
