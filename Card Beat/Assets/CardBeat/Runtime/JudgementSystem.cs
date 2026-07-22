using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;

namespace CardBeat
{
    public enum Judgement { Perfect, Good, Miss }

    /// <summary>
    /// Single-button input judgement against the chart's note list.
    /// Space / click / tap hits the nearest unjudged note; notes that drift past the good
    /// window become misses. Autoplay hits every note exactly on time (editor preview).
    /// </summary>
    public class JudgementSystem : MonoBehaviour
    {
        public RhythmChart chart;
        public bool autoplay;

        public event Action<ChartNote, Judgement, float> OnJudged; // note, verdict, deltaSec (+late)
        public event Action OnStrayTap; // tap with no note in range

        public int PerfectCount { get; private set; }
        public int GoodCount { get; private set; }
        public int MissCount { get; private set; }
        public int Combo { get; private set; }
        public int MaxCombo { get; private set; }
        public int Score { get; private set; }
        public int TotalNotes => _notes.Count;
        public int JudgedCount => PerfectCount + GoodCount + MissCount;

        List<ChartNote> _notes = new List<ChartNote>();
        bool[] _judged;
        int _scan; // first possibly-unjudged index

        public IReadOnlyList<ChartNote> Notes => _notes;
        public bool IsJudged(int i) => _judged[i];

        public void Begin(RhythmChart c)
        {
            chart = c;
            _notes = c.BuildNoteList();
            _judged = new bool[_notes.Count];
            _scan = 0;
            PerfectCount = GoodCount = MissCount = Combo = MaxCombo = Score = 0;
        }

        public void Tick(float songTime)
        {
            if (chart == null || _judged == null) return;

            if (autoplay)
            {
                for (int i = _scan; i < _notes.Count && _notes[i].timeSec <= songTime; i++)
                    if (!_judged[i]) Judge(i, Judgement.Perfect, 0f);
            }
            else if (WasTapped())
            {
                TapAt(songTime);
            }

            // overdue notes become misses
            for (int i = _scan; i < _notes.Count; i++)
            {
                if (_notes[i].timeSec > songTime - chart.goodWindow) break;
                if (!_judged[i]) Judge(i, Judgement.Miss, chart.goodWindow);
            }
            while (_scan < _notes.Count && _judged[_scan]) _scan++;
        }

        static bool WasTapped()
        {
            var kb = Keyboard.current;
            if (kb != null && (kb.spaceKey.wasPressedThisFrame || kb.enterKey.wasPressedThisFrame)) return true;
            var m = Mouse.current;
            if (m != null && m.leftButton.wasPressedThisFrame) return true;
            var ts = Touchscreen.current;
            if (ts != null && ts.primaryTouch.press.wasPressedThisFrame) return true;
            return false;
        }

        void TapAt(float songTime)
        {
            int best = -1;
            float bestAbs = float.MaxValue;
            for (int i = _scan; i < _notes.Count; i++)
            {
                if (_judged[i]) continue;
                float d = songTime - _notes[i].timeSec;
                if (d > chart.goodWindow) continue;      // already counted as miss soon
                if (-d > chart.goodWindow) break;        // too early, and list is sorted
                float a = Mathf.Abs(d);
                if (a < bestAbs) { bestAbs = a; best = i; }
            }
            if (best < 0) { OnStrayTap?.Invoke(); return; }
            float delta = songTime - _notes[best].timeSec;
            Judge(best, bestAbs <= chart.perfectWindow ? Judgement.Perfect : Judgement.Good, delta);
        }

        void Judge(int i, Judgement j, float delta)
        {
            _judged[i] = true;
            switch (j)
            {
                case Judgement.Perfect:
                    PerfectCount++; Combo++; Score += 300 + Combo * 5; break;
                case Judgement.Good:
                    GoodCount++; Combo++; Score += 100 + Combo * 2; break;
                case Judgement.Miss:
                    MissCount++; Combo = 0; break;
            }
            MaxCombo = Mathf.Max(MaxCombo, Combo);
            OnJudged?.Invoke(_notes[i], j, delta);
        }

        public float Accuracy =>
            JudgedCount == 0 ? 1f : (PerfectCount + 0.5f * GoodCount) / JudgedCount;
    }
}
