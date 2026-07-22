using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// A playable chart: a song, a beat grid (bpm + offset), Card Beat clip events placed on
    /// the song timeline, and notes. Notes come from two sources: clip anchors (auto-derived,
    /// they follow the clip when it moves) and manual notes added in the chart editor.
    /// All times are song seconds.
    /// </summary>
    [CreateAssetMenu(menuName = "Card Beat/Rhythm Chart", fileName = "NewChart")]
    public class RhythmChart : ScriptableObject
    {
        [Header("Song")]
        public AudioClip song;
        public float bpm = 100f;
        [Tooltip("Song time of beat 0 — shifts the whole beat grid.")]
        public float offsetSec = 0f;
        [Tooltip("Silence before the song starts, so early notes are hittable.")]
        public float leadInSec = 2f;

        [Header("Judgement windows (± seconds)")]
        public float perfectWindow = 0.06f;
        public float goodWindow = 0.13f;

        [Header("Game rules")]
        [Tooltip("Cards the performer starts with; misses drop cards.")]
        public int startingCards = 20;
        [Tooltip("Cards dropped per missed note.")]
        public int cardsPerMiss = 2;

        [Header("Content")]
        public List<ClipEvent> clipEvents = new List<ClipEvent>();
        public List<ChartNote> manualNotes = new List<ChartNote>();

        public float SecPerBeat => 60f / Mathf.Max(1f, bpm);

        public float SongLength => song != null ? song.length : EndOfContent();

        public float EndOfContent()
        {
            float end = 0f;
            foreach (var e in clipEvents)
                if (e.clip != null) end = Mathf.Max(end, e.startSec + e.clip.DurationSec);
            foreach (var n in manualNotes) end = Mathf.Max(end, n.timeSec);
            return end;
        }

        /// <summary>Snap a song time to the nearest grid line at the given beat division.</summary>
        public float Snap(float timeSec, int division)
        {
            float step = SecPerBeat / Mathf.Max(1, division);
            return offsetSec + Mathf.Round((timeSec - offsetSec) / step) * step;
        }

        public float TimeToBeat(float timeSec) => (timeSec - offsetSec) / SecPerBeat;
        public float BeatToTime(float beat) => offsetSec + beat * SecPerBeat;

        /// <summary>
        /// The full judged note list: manual notes plus notes derived from each clip event's
        /// anchor times (unless the event opted out), sorted by time.
        /// </summary>
        public List<ChartNote> BuildNoteList()
        {
            var notes = new List<ChartNote>();
            foreach (var n in manualNotes)
                notes.Add(new ChartNote { timeSec = n.timeSec, accent = n.accent, fromClip = false });
            foreach (var e in clipEvents)
            {
                if (e.clip == null || !e.autoNotes) continue;
                foreach (var a in e.clip.AnchorTimes())
                    notes.Add(new ChartNote { timeSec = e.startSec + a, accent = true, fromClip = true });
            }
            return notes.OrderBy(n => n.timeSec).ToList();
        }

        /// <summary>The clip event active at a song time, or null.</summary>
        public ClipEvent ActiveClipAt(float timeSec)
        {
            ClipEvent best = null;
            foreach (var e in clipEvents)
            {
                if (e.clip == null) continue;
                if (timeSec >= e.startSec && timeSec < e.startSec + e.clip.DurationSec)
                    if (best == null || e.startSec > best.startSec) best = e; // latest wins on overlap
            }
            return best;
        }
    }

    /// <summary>A Card Beat clip placed on the song timeline.</summary>
    [Serializable]
    public class ClipEvent
    {
        public CardBeatClipAsset clip;
        public float startSec;
        [Tooltip("Derive hit notes from the clip's beat anchors.")]
        public bool autoNotes = true;
    }

    /// <summary>A single hit moment the player must tap on.</summary>
    [Serializable]
    public class ChartNote
    {
        public float timeSec;
        public bool accent = true;
        [NonSerialized] public bool fromClip;
    }
}
