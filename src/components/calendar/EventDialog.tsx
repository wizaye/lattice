/**
 * v2 §1.5 — Create / edit a local calendar event.
 *
 * Today this dialog only handles `source = "local"` events.  When
 * Outlook / Cal.com / Google write-back lands in a later slice, the
 * dialog will gain a "calendar" picker at the top and re-target the
 * create call accordingly — the form shape is intentionally
 * provider-agnostic so that change is purely additive.
 *
 * ## Time-zone discipline
 *
 * The form uses three native inputs: `<input type="date">` +
 * `<input type="time">` (start) + `<input type="time">` (end).  Each
 * speaks the user's local zone.  We assemble `new Date(y, m, d, hh, mm)`
 * which yields a `Date` in local time and then call `.toISOString()`
 * to ship UTC over the wire.  This matches what every commodity
 * calendar app does and avoids the entire "ambiguous wall-clock"
 * class of bug.
 */

import { useEffect, useState } from "react";

import { useCalendarStore } from "../../state/calendarStore";
import type { CalEvent, CalEventInput } from "../../lib/calendarApi";
import { IcClose } from "../common/Icons";

import "./EventDialog.css";

type Props = {
  vaultPath: string;
  /**
   * `YYYY-MM-DD` to pre-fill the date input with.  Used when the
   * user clicked "+" from a day cell — the new event lands on the
   * day they were looking at, not arbitrary "today".
   */
  initialDate: string;
  /**
   * If non-null, the dialog is in EDIT mode — fields are pre-filled
   * from this event and Save calls `updateEvent` instead of
   * `createEvent`.
   */
  existing: CalEvent | null;
  onClose: () => void;
};

/** Split a UTC ISO string into local-zone `YYYY-MM-DD` + `HH:MM` parts. */
function splitLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { date, time };
}

/** Combine local-zone date + time parts → UTC ISO string. */
function joinLocal(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0).toISOString();
}

export function EventDialog({
  vaultPath,
  initialDate,
  existing,
  onClose,
}: Props) {
  const createEvent = useCalendarStore((s) => s.createEvent);
  const updateEvent = useCalendarStore((s) => s.updateEvent);

  const [title, setTitle] = useState("");
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [bodyMd, setBodyMd] = useState("");
  const [attendees, setAttendees] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from `existing` when editing.  Done in an effect (vs.
  // useState initialiser) so the form re-populates if the parent
  // swaps `existing` while the dialog stays mounted.
  useEffect(() => {
    if (!existing) {
      setTitle("");
      setDate(initialDate);
      setStartTime("09:00");
      setEndTime("10:00");
      setBodyMd("");
      setAttendees("");
      setMeetingUrl("");
      return;
    }
    setTitle(existing.title);
    const start = splitLocal(existing.start);
    const end = splitLocal(existing.end);
    setDate(start.date);
    setStartTime(start.time);
    setEndTime(end.time);
    setBodyMd(existing.body_md ?? "");
    setAttendees(existing.attendees.join(", "));
    setMeetingUrl(existing.meeting_url ?? "");
  }, [existing, initialDate]);

  // ESC closes — matches the convention used by other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    const startIso = joinLocal(date, startTime);
    const endIso = joinLocal(date, endTime);
    if (new Date(startIso) >= new Date(endIso)) {
      setError("End time must be after start time.");
      return;
    }
    const attendeeList = attendees
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setSubmitting(true);
    try {
      if (existing) {
        await updateEvent(vaultPath, {
          ...existing,
          title: title.trim(),
          start: startIso,
          end: endIso,
          body_md: bodyMd.trim() ? bodyMd : null,
          attendees: attendeeList,
          meeting_url: meetingUrl.trim() ? meetingUrl.trim() : null,
        });
      } else {
        const input: CalEventInput = {
          title: title.trim(),
          start: startIso,
          end: endIso,
          body_md: bodyMd.trim() ? bodyMd : null,
          attendees: attendeeList,
          meeting_url: meetingUrl.trim() ? meetingUrl.trim() : null,
        };
        await createEvent(vaultPath, input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="evd-overlay"
      onClick={(e) => {
        // Click on scrim (but not on the dialog itself) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="evd-dialog" role="dialog" aria-modal="true">
        <button className="evd-close icon-btn tiny" onClick={onClose} title="Close">
          <IcClose />
        </button>
        <div className="evd-header">
          <div className="evd-title">{existing ? "Edit event" : "New event"}</div>
          <div className="evd-subtitle">
            {existing
              ? "Update the local event in this vault."
              : "Create a local event in this vault."}
          </div>
        </div>
        <form
          className="evd-body"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="evd-field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              required
            />
          </label>
          <div className="evd-row">
            <label className="evd-field">
              <span>Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </label>
            <label className="evd-field">
              <span>Start</span>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
              />
            </label>
            <label className="evd-field">
              <span>End</span>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
              />
            </label>
          </div>
          <label className="evd-field">
            <span>Attendees (comma-separated)</span>
            <input
              type="text"
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
            />
          </label>
          <label className="evd-field">
            <span>Meeting URL</span>
            <input
              type="url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://meet.example.com/…"
            />
          </label>
          <label className="evd-field">
            <span>Notes (markdown)</span>
            <textarea
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
              rows={4}
              placeholder="Agenda, prep, action items…"
            />
          </label>
          {error && <div className="evd-error">{error}</div>}
          <div className="evd-footer">
            <button
              type="button"
              className="evd-btn evd-btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="evd-btn evd-btn-primary"
              disabled={submitting}
            >
              {submitting ? "Saving…" : existing ? "Save changes" : "Create event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
