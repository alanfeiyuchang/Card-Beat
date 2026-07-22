using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace CardBeat.EditorTools
{
    /// <summary>
    /// The rhythm-game chart editor. Timeline with song waveform + beat grid, clip events
    /// (Card Beat clips whose anchors auto-generate notes), manual note editing with snapping,
    /// edit-mode playback with metronome, tap tempo, zoom/pan/scrub, undo, and test play.
    ///
    /// Shortcuts: Space play/pause · B note at playhead · ←/→ step (⇧×4) · Home start ·
    /// Delete remove selection · scroll wheel zoom · middle-drag pan.
    /// </summary>
    public class ChartEditorWindow : EditorWindow
    {
        [MenuItem("Card Beat/Chart Editor")]
        public static void Open() => GetWindow<ChartEditorWindow>("Chart Editor");

        RhythmChart chart;
        readonly EditorAudioPreview _audio = new EditorAudioPreview();

        // view
        float _pxPerSec = 120f;
        float _scrollX;          // left edge of view, in song seconds
        float _playhead;
        int _snapDiv = 2;
        bool _snap = true;
        float _speed = 1f;

        // selection / drag
        int _selNote = -1, _selEvent = -1;
        enum DragKind { None, Playhead, Note, Event, Pan }
        DragKind _drag = DragKind.None;
        float _dragOffset;

        // tap tempo
        readonly List<double> _taps = new List<double>();

        // waveform cache
        AudioClip _wfClip;
        Texture2D _wfTex;

        Vector2 _paletteScroll;

        static readonly Color GridBeat = new Color(1, 1, 1, 0.22f);
        static readonly Color GridSub = new Color(1, 1, 1, 0.07f);
        static readonly Color GridBar = new Color(1f, 0.8f, 0.3f, 0.35f);
        static readonly Color NoteManual = new Color(0.35f, 0.8f, 1f);
        static readonly Color NoteAccent = new Color(1f, 0.85f, 0.2f);
        static readonly Color NoteDerived = new Color(1f, 0.55f, 0.25f);
        static readonly Color EventBlock = new Color(0.3f, 0.5f, 0.9f, 0.55f);

        void OnEnable()
        {
            EditorApplication.update += Tick;
            Undo.undoRedoPerformed += Repaint;
            wantsMouseMove = true;
        }

        void OnDisable()
        {
            EditorApplication.update -= Tick;
            Undo.undoRedoPerformed -= Repaint;
            _audio.Dispose();
        }

        void Tick()
        {
            if (!_audio.IsPlaying) return;
            _audio.Update();
            _playhead = _audio.Time;
            // auto-follow
            float viewSec = position.width / _pxPerSec;
            if (_playhead > _scrollX + viewSec * 0.85f) _scrollX = _playhead - viewSec * 0.15f;
            if (SongLen() > 0 && _playhead > SongLen() + 2f) _audio.Stop();
            Repaint();
        }

        float SongLen() => chart == null ? 0f :
            Mathf.Max(chart.song != null ? chart.song.length : 0f, chart.EndOfContent() + 2f);

        (float, bool)? GridBeatAt(int i)
        {
            if (chart == null) return null;
            float t = chart.offsetSec + i * chart.SecPerBeat;
            if (t > SongLen() + 2f) return null;
            return (t, i % 4 == 0);
        }

        // ---------------------------------------------------------------- GUI

        void OnGUI()
        {
            DrawToolbar();
            if (chart == null)
            {
                EditorGUILayout.HelpBox(
                    "Assign or create a Rhythm Chart (Assets ▸ Create ▸ Card Beat ▸ Rhythm Chart).\n" +
                    "Import clips via Card Beat ▸ Import Package (.zip)…", MessageType.Info);
                return;
            }
            DrawSongRow();

            float bottomH = 168f;
            var tl = new Rect(0, GUILayoutUtility.GetLastRect().yMax + 4,
                position.width, position.height - GUILayoutUtility.GetLastRect().yMax - bottomH - 8);
            if (tl.height > 80) DrawTimeline(tl);
            GUILayout.FlexibleSpace();
            DrawBottomPanel();
            HandleKeys();
        }

        void DrawToolbar()
        {
            EditorGUILayout.BeginHorizontal(EditorStyles.toolbar);
            var newChart = (RhythmChart)EditorGUILayout.ObjectField(chart, typeof(RhythmChart), false, GUILayout.Width(200));
            if (newChart != chart) { chart = newChart; _selNote = _selEvent = -1; _audio.Stop(); }

            using (new EditorGUI.DisabledScope(chart == null))
            {
                if (GUILayout.Button(_audio.IsPlaying ? "❚❚" : "▶", EditorStyles.toolbarButton, GUILayout.Width(32)))
                    TogglePlay();
                if (GUILayout.Button("■", EditorStyles.toolbarButton, GUILayout.Width(28)))
                { _audio.Stop(); _playhead = 0; _scrollX = 0; }

                _speed = FloatPopup("speed", _speed, new[] { 0.5f, 0.75f, 1f }, 90);
                _audio.metronome = GUILayout.Toggle(_audio.metronome, "metronome", EditorStyles.toolbarButton, GUILayout.Width(80));

                GUILayout.Space(12);
                _snap = GUILayout.Toggle(_snap, "snap", EditorStyles.toolbarButton, GUILayout.Width(46));
                _snapDiv = (int)FloatPopup("1/", _snapDiv, new[] { 1f, 2f, 3f, 4f, 6f, 8f }, 64);

                GUILayout.FlexibleSpace();
                GUILayout.Label($"{_playhead:0.00}s · beat {(chart != null ? chart.TimeToBeat(_playhead) : 0):0.00}",
                    EditorStyles.toolbarButton);
                GUILayout.FlexibleSpace();

                if (GUILayout.Button("Test Play ▶", EditorStyles.toolbarButton, GUILayout.Width(90)))
                    TestPlay();
            }
            EditorGUILayout.EndHorizontal();
        }

        static float FloatPopup(string prefix, float val, float[] options, int width)
        {
            var labels = options.Select(o => prefix + (prefix == "1/" ? o.ToString("0") : "×" + o.ToString("0.##"))).ToArray();
            int idx = System.Array.IndexOf(options, val);
            if (idx < 0) idx = options.Length - 1;
            idx = EditorGUILayout.Popup(idx, labels, EditorStyles.toolbarPopup, GUILayout.Width(width));
            return options[idx];
        }

        void DrawSongRow()
        {
            EditorGUILayout.BeginHorizontal();
            EditorGUI.BeginChangeCheck();
            var song = (AudioClip)EditorGUILayout.ObjectField("Song", chart.song, typeof(AudioClip), false, GUILayout.MaxWidth(320));
            float bpm = EditorGUILayout.FloatField("BPM", chart.bpm, GUILayout.MaxWidth(200));
            if (GUILayout.Button("Tap", GUILayout.Width(44))) bpm = TapTempo(bpm);
            float off = EditorGUILayout.FloatField("Offset", chart.offsetSec, GUILayout.MaxWidth(200));
            if (GUILayout.Button("−10ms", GUILayout.Width(52))) off -= 0.01f;
            if (GUILayout.Button("+10ms", GUILayout.Width(52))) off += 0.01f;
            if (EditorGUI.EndChangeCheck())
            {
                Undo.RecordObject(chart, "Chart Song Settings");
                chart.song = song; chart.bpm = Mathf.Clamp(bpm, 20f, 300f); chart.offsetSec = off;
                EditorUtility.SetDirty(chart);
            }
            GUILayout.FlexibleSpace();
            var notes = chart.BuildNoteList();
            GUILayout.Label($"{notes.Count} notes · {chart.clipEvents.Count} clips · {SongLen():0.0}s", EditorStyles.miniLabel);
            EditorGUILayout.EndHorizontal();
        }

        float TapTempo(float current)
        {
            double now = EditorApplication.timeSinceStartup;
            if (_taps.Count > 0 && now - _taps[_taps.Count - 1] > 2.0) _taps.Clear();
            _taps.Add(now);
            if (_taps.Count < 3) return current;
            var iv = new List<double>();
            for (int i = 1; i < _taps.Count; i++) iv.Add(_taps[i] - _taps[i - 1]);
            iv.Sort();
            double median = iv[iv.Count / 2];
            return Mathf.Round((float)(60.0 / median) * 10f) / 10f;
        }

        // ---------------------------------------------------------------- timeline

        float ToX(Rect r, float t) => r.x + (t - _scrollX) * _pxPerSec;
        float ToT(Rect r, float x) => _scrollX + (x - r.x) / _pxPerSec;
        float MaybeSnap(float t) => _snap ? chart.Snap(t, _snapDiv) : t;

        void DrawTimeline(Rect r)
        {
            var ruler = new Rect(r.x, r.y, r.width, 22);
            var wave = new Rect(r.x, ruler.yMax, r.width, Mathf.Max(60, r.height - 22 - 64 - 74));
            var noteLane = new Rect(r.x, wave.yMax, r.width, 64);
            var clipLane = new Rect(r.x, noteLane.yMax, r.width, 74);

            EditorGUI.DrawRect(r, new Color(0.13f, 0.13f, 0.16f));
            EditorGUI.DrawRect(ruler, new Color(0.1f, 0.1f, 0.12f));
            EditorGUI.DrawRect(noteLane, new Color(0.16f, 0.16f, 0.20f));
            EditorGUI.DrawRect(clipLane, new Color(0.12f, 0.14f, 0.12f));

            DrawWaveform(wave);
            DrawGrid(r, ruler);
            DrawClipEvents(clipLane);
            DrawNotes(noteLane);

            // playhead
            float px = ToX(r, _playhead);
            if (px >= r.x && px <= r.xMax)
            {
                EditorGUI.DrawRect(new Rect(px - 1, r.y, 2, r.height), new Color(1f, 0.3f, 0.3f, 0.9f));
            }

            GUI.Label(new Rect(noteLane.x + 4, noteLane.y + 2, 200, 16), "notes", EditorStyles.miniLabel);
            GUI.Label(new Rect(clipLane.x + 4, clipLane.y + 2, 200, 16), "clips", EditorStyles.miniLabel);

            HandleTimelineInput(r, ruler, wave, noteLane, clipLane);
        }

        void DrawGrid(Rect full, Rect ruler)
        {
            float step = chart.SecPerBeat / _snapDiv;
            float tEnd = _scrollX + full.width / _pxPerSec;
            int i0 = Mathf.Max(0, Mathf.FloorToInt((_scrollX - chart.offsetSec) / step));
            for (int i = i0; ; i++)
            {
                float t = chart.offsetSec + i * step;
                if (t > tEnd) break;
                float x = ToX(full, t);
                bool isBeat = i % _snapDiv == 0;
                int beatIdx = i / _snapDiv;
                bool isBar = isBeat && beatIdx % 4 == 0;
                var c = isBar ? GridBar : isBeat ? GridBeat : GridSub;
                EditorGUI.DrawRect(new Rect(x, full.y + (isBeat ? 0 : 22), 1, full.height - (isBeat ? 0 : 22)), c);
                if (isBar)
                    GUI.Label(new Rect(x + 2, ruler.y + 3, 60, 16), (beatIdx / 4 + 1).ToString(), EditorStyles.miniLabel);
            }
            // second ticks on the ruler
            for (int s = Mathf.Max(0, Mathf.FloorToInt(_scrollX)); s < tEnd; s++)
            {
                float x = ToX(full, s);
                EditorGUI.DrawRect(new Rect(x, ruler.yMax - 5, 1, 5), new Color(1, 1, 1, 0.4f));
                if (_pxPerSec > 40)
                    GUI.Label(new Rect(x + 2, ruler.yMax - 17, 50, 14), $"{s}s", EditorStyles.centeredGreyMiniLabel);
            }
        }

        void DrawWaveform(Rect r)
        {
            if (chart.song == null)
            {
                GUI.Label(r, "  (no song assigned — grid uses BPM only)", EditorStyles.centeredGreyMiniLabel);
                return;
            }
            BuildWaveTex(chart.song);
            if (_wfTex == null) return;
            float len = chart.song.length;
            float u0 = Mathf.Clamp01(_scrollX / len);
            float u1 = Mathf.Clamp01((_scrollX + r.width / _pxPerSec) / len);
            if (u1 <= u0) return;
            float xEnd = ToX(r, Mathf.Min(len, _scrollX + r.width / _pxPerSec));
            var dst = new Rect(Mathf.Max(r.x, ToX(r, 0)), r.y, xEnd - Mathf.Max(r.x, ToX(r, 0)), r.height);
            GUI.DrawTextureWithTexCoords(dst, _wfTex, new Rect(u0, 0, u1 - u0, 1));
        }

        void BuildWaveTex(AudioClip clip)
        {
            if (_wfClip == clip && _wfTex != null) return;
            _wfClip = clip;
            const int W = 2048, H = 128;
            var samples = new float[clip.samples * clip.channels];
            try { clip.GetData(samples, 0); }
            catch { _wfTex = null; return; }

            _wfTex = new Texture2D(W, H, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
            var px = new Color32[W * H];
            var bg = new Color32(0, 0, 0, 0);
            var fg = new Color32(90, 170, 220, 200);
            int per = Mathf.Max(1, samples.Length / W);
            for (int x = 0; x < W; x++)
            {
                float lo = 0, hi = 0;
                int s0 = x * per, s1 = Mathf.Min(samples.Length, s0 + per);
                for (int s = s0; s < s1; s++) { if (samples[s] < lo) lo = samples[s]; if (samples[s] > hi) hi = samples[s]; }
                int yLo = Mathf.Clamp((int)((lo * 0.95f + 1f) * 0.5f * H), 0, H - 1);
                int yHi = Mathf.Clamp((int)((hi * 0.95f + 1f) * 0.5f * H), 0, H - 1);
                for (int y = 0; y < H; y++) px[y * W + x] = (y >= yLo && y <= yHi) ? fg : bg;
            }
            _wfTex.SetPixels32(px);
            _wfTex.Apply();
        }

        void DrawNotes(Rect lane)
        {
            float cy = lane.center.y + 6;
            // derived (from clip anchors) — read-only diamonds
            foreach (var e in chart.clipEvents)
            {
                if (e.clip == null || !e.autoNotes) continue;
                foreach (var a in e.clip.AnchorTimes())
                    DrawDiamond(new Vector2(ToX(lane, e.startSec + a), cy), 6f, NoteDerived);
            }
            // manual notes
            for (int i = 0; i < chart.manualNotes.Count; i++)
            {
                var n = chart.manualNotes[i];
                float x = ToX(lane, n.timeSec);
                if (x < lane.x - 10 || x > lane.xMax + 10) continue;
                var col = n.accent ? NoteAccent : NoteManual;
                float rad = i == _selNote ? 9f : 7f;
                DrawDisc(new Vector2(x, cy), rad, col, i == _selNote);
            }
        }

        void DrawClipEvents(Rect lane)
        {
            for (int i = 0; i < chart.clipEvents.Count; i++)
            {
                var e = chart.clipEvents[i];
                if (e.clip == null) continue;
                float x0 = ToX(lane, e.startSec);
                float x1 = ToX(lane, e.startSec + e.clip.DurationSec);
                if (x1 < lane.x || x0 > lane.xMax) continue;
                var block = new Rect(x0, lane.y + 16, Mathf.Max(6, x1 - x0), lane.height - 22);
                EditorGUI.DrawRect(block, i == _selEvent ? new Color(0.45f, 0.65f, 1f, 0.75f) : EventBlock);
                // anchor ticks inside the block
                foreach (var a in e.clip.AnchorTimes())
                    EditorGUI.DrawRect(new Rect(ToX(lane, e.startSec + a) - 1, block.y, 2, block.height), NoteDerived);
                var label = $"{e.clip.name}{(e.autoNotes ? "" : "  (no auto-notes)")}";
                GUI.Label(new Rect(block.x + 4, block.y + 2, Mathf.Max(60, block.width - 8), 16), label, EditorStyles.whiteMiniLabel);
            }
        }

        static void DrawDisc(Vector2 c, float r, Color col, bool outline = false)
        {
            var prev = Handles.color;
            Handles.color = col;
            Handles.DrawSolidDisc(c, Vector3.forward, r);
            if (outline) { Handles.color = Color.white; Handles.DrawWireDisc(c, Vector3.forward, r + 1.5f); }
            Handles.color = prev;
        }

        static void DrawDiamond(Vector2 c, float r, Color col)
        {
            var prev = Handles.color;
            Handles.color = col;
            Handles.DrawAAConvexPolygon(
                c + Vector2.up * r, c + Vector2.right * r, c + Vector2.down * r, c + Vector2.left * r);
            Handles.color = prev;
        }

        // ---------------------------------------------------------------- input

        void HandleTimelineInput(Rect full, Rect ruler, Rect wave, Rect noteLane, Rect clipLane)
        {
            var e = Event.current;
            if (!full.Contains(e.mousePosition) && _drag == DragKind.None) return;
            float t = ToT(full, e.mousePosition.x);

            switch (e.type)
            {
                case EventType.ScrollWheel:
                {
                    float factor = e.delta.y > 0 ? 0.85f : 1.18f;
                    float tAnchor = t;
                    _pxPerSec = Mathf.Clamp(_pxPerSec * factor, 8f, 1200f);
                    _scrollX = Mathf.Max(0, tAnchor - (e.mousePosition.x - full.x) / _pxPerSec);
                    e.Use(); Repaint();
                    break;
                }
                case EventType.MouseDown when e.button == 2:
                    _drag = DragKind.Pan; _dragOffset = e.mousePosition.x; e.Use();
                    break;
                case EventType.MouseDown when e.button == 0:
                    OnLeftDown(e, t, ruler, wave, noteLane, clipLane);
                    break;
                case EventType.MouseDown when e.button == 1:
                    OnContext(e, t, noteLane, clipLane);
                    break;
                case EventType.MouseDrag:
                    OnDrag(e, t, full);
                    break;
                case EventType.MouseUp:
                    _drag = DragKind.None;
                    break;
            }
        }

        void OnLeftDown(Event e, float t, Rect ruler, Rect wave, Rect noteLane, Rect clipLane)
        {
            if (ruler.Contains(e.mousePosition) || wave.Contains(e.mousePosition))
            {
                _drag = DragKind.Playhead;
                SetPlayhead(Mathf.Max(0, t));
                e.Use(); Repaint(); return;
            }
            if (noteLane.Contains(e.mousePosition))
            {
                int hit = HitNote(noteLane, e.mousePosition);
                if (hit >= 0)
                {
                    _selNote = hit; _selEvent = -1;
                    _drag = DragKind.Note;
                    _dragOffset = chart.manualNotes[hit].timeSec - t;
                }
                else
                {
                    Undo.RecordObject(chart, "Add Note");
                    chart.manualNotes.Add(new ChartNote { timeSec = Mathf.Max(0, MaybeSnap(t)), accent = e.shift });
                    chart.manualNotes.Sort((a, b) => a.timeSec.CompareTo(b.timeSec));
                    _selNote = chart.manualNotes.FindIndex(n => Mathf.Approximately(n.timeSec, Mathf.Max(0, MaybeSnap(t))));
                    _selEvent = -1;
                    EditorUtility.SetDirty(chart);
                }
                e.Use(); Repaint(); return;
            }
            if (clipLane.Contains(e.mousePosition))
            {
                int hit = HitEvent(t);
                _selEvent = hit; _selNote = -1;
                if (hit >= 0)
                {
                    _drag = DragKind.Event;
                    _dragOffset = chart.clipEvents[hit].startSec - t;
                }
                e.Use(); Repaint();
            }
        }

        void OnDrag(Event e, float t, Rect full)
        {
            switch (_drag)
            {
                case DragKind.Playhead:
                    SetPlayhead(Mathf.Max(0, t)); e.Use(); Repaint(); break;
                case DragKind.Pan:
                    _scrollX = Mathf.Max(0, _scrollX - (e.mousePosition.x - _dragOffset) / _pxPerSec);
                    _dragOffset = e.mousePosition.x; e.Use(); Repaint(); break;
                case DragKind.Note when _selNote >= 0 && _selNote < chart.manualNotes.Count:
                    Undo.RecordObject(chart, "Move Note");
                    chart.manualNotes[_selNote].timeSec = Mathf.Max(0, MaybeSnap(t + _dragOffset));
                    EditorUtility.SetDirty(chart); e.Use(); Repaint(); break;
                case DragKind.Event when _selEvent >= 0 && _selEvent < chart.clipEvents.Count:
                    Undo.RecordObject(chart, "Move Clip Event");
                    chart.clipEvents[_selEvent].startSec = Mathf.Max(0, MaybeSnap(t + _dragOffset));
                    EditorUtility.SetDirty(chart); e.Use(); Repaint(); break;
            }
        }

        void OnContext(Event e, float t, Rect noteLane, Rect clipLane)
        {
            if (noteLane.Contains(e.mousePosition))
            {
                int hit = HitNote(noteLane, e.mousePosition);
                if (hit < 0) return;
                var menu = new GenericMenu();
                menu.AddItem(new GUIContent("Toggle accent"), false, () =>
                {
                    Undo.RecordObject(chart, "Toggle Accent");
                    chart.manualNotes[hit].accent = !chart.manualNotes[hit].accent;
                    EditorUtility.SetDirty(chart);
                });
                menu.AddItem(new GUIContent("Delete note"), false, () =>
                {
                    Undo.RecordObject(chart, "Delete Note");
                    chart.manualNotes.RemoveAt(hit);
                    _selNote = -1;
                    EditorUtility.SetDirty(chart);
                });
                menu.ShowAsContext();
                e.Use();
            }
            else if (clipLane.Contains(e.mousePosition))
            {
                int hit = HitEvent(t);
                if (hit < 0) return;
                var ev = chart.clipEvents[hit];
                var menu = new GenericMenu();
                menu.AddItem(new GUIContent("Auto-notes from anchors"), ev.autoNotes, () =>
                {
                    Undo.RecordObject(chart, "Toggle Auto Notes");
                    ev.autoNotes = !ev.autoNotes;
                    EditorUtility.SetDirty(chart);
                });
                menu.AddItem(new GUIContent("Bake anchors → editable notes"), false, () => BakeEvent(hit));
                menu.AddSeparator("");
                menu.AddItem(new GUIContent("Delete clip event"), false, () =>
                {
                    Undo.RecordObject(chart, "Delete Clip Event");
                    chart.clipEvents.RemoveAt(hit);
                    _selEvent = -1;
                    EditorUtility.SetDirty(chart);
                });
                menu.ShowAsContext();
                e.Use();
            }
        }

        int HitNote(Rect lane, Vector2 mouse)
        {
            float cy = lane.center.y + 6;
            int best = -1; float bestD = 12f;
            for (int i = 0; i < chart.manualNotes.Count; i++)
            {
                float d = Vector2.Distance(mouse, new Vector2(ToX(lane, chart.manualNotes[i].timeSec), cy));
                if (d < bestD) { bestD = d; best = i; }
            }
            return best;
        }

        int HitEvent(float t)
        {
            for (int i = chart.clipEvents.Count - 1; i >= 0; i--)
            {
                var e = chart.clipEvents[i];
                if (e.clip != null && t >= e.startSec && t <= e.startSec + e.clip.DurationSec) return i;
            }
            return -1;
        }

        void BakeEvent(int idx)
        {
            var ev = chart.clipEvents[idx];
            if (ev.clip == null) return;
            Undo.RecordObject(chart, "Bake Anchors");
            foreach (var a in ev.clip.AnchorTimes())
                chart.manualNotes.Add(new ChartNote { timeSec = ev.startSec + a, accent = true });
            chart.manualNotes.Sort((a, b) => a.timeSec.CompareTo(b.timeSec));
            ev.autoNotes = false;
            EditorUtility.SetDirty(chart);
        }

        // ---------------------------------------------------------------- bottom panel

        void DrawBottomPanel()
        {
            EditorGUILayout.BeginHorizontal(GUILayout.Height(160));

            // clip palette
            EditorGUILayout.BeginVertical(GUILayout.Width(300));
            GUILayout.Label("Card Beat clips", EditorStyles.boldLabel);
            _paletteScroll = EditorGUILayout.BeginScrollView(_paletteScroll);
            var guids = AssetDatabase.FindAssets("t:CardBeatClipAsset");
            if (guids.Length == 0)
                GUILayout.Label("none imported yet", EditorStyles.miniLabel);
            foreach (var g in guids)
            {
                var clip = AssetDatabase.LoadAssetAtPath<CardBeatClipAsset>(AssetDatabase.GUIDToAssetPath(g));
                if (clip == null) continue;
                EditorGUILayout.BeginHorizontal();
                GUILayout.Label($"{clip.name}  ({clip.DurationSec:0.0}s, {clip.AnchorTimes().Count} anchors)", GUILayout.MinWidth(160));
                if (GUILayout.Button("+ at playhead", GUILayout.Width(96)))
                {
                    Undo.RecordObject(chart, "Add Clip Event");
                    chart.clipEvents.Add(new ClipEvent { clip = clip, startSec = MaybeSnap(_playhead) });
                    _selEvent = chart.clipEvents.Count - 1; _selNote = -1;
                    EditorUtility.SetDirty(chart);
                }
                EditorGUILayout.EndHorizontal();
            }
            EditorGUILayout.EndScrollView();
            EditorGUILayout.EndVertical();

            GUILayout.Space(16);

            // selection inspector
            EditorGUILayout.BeginVertical();
            if (_selEvent >= 0 && _selEvent < chart.clipEvents.Count)
                DrawEventInspector(chart.clipEvents[_selEvent]);
            else if (_selNote >= 0 && _selNote < chart.manualNotes.Count)
                DrawNoteInspector(chart.manualNotes[_selNote]);
            else
            {
                GUILayout.Label("Selection", EditorStyles.boldLabel);
                GUILayout.Label("Click a note or clip block to edit it.\n" +
                    "Click empty note lane to add a note (⇧ = accent).\n" +
                    "Right-click for actions. B adds a note at the playhead.", EditorStyles.miniLabel);
            }
            GUILayout.FlexibleSpace();
            DrawJudgementRow();
            EditorGUILayout.EndVertical();

            EditorGUILayout.EndHorizontal();
        }

        void DrawEventInspector(ClipEvent ev)
        {
            GUILayout.Label($"Clip event — {(ev.clip != null ? ev.clip.name : "missing clip")}", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            float start = EditorGUILayout.FloatField("Start (s)", ev.startSec, GUILayout.MaxWidth(240));
            bool auto = EditorGUILayout.Toggle("Auto-notes", ev.autoNotes, GUILayout.MaxWidth(240));
            if (EditorGUI.EndChangeCheck())
            {
                Undo.RecordObject(chart, "Edit Clip Event");
                ev.startSec = Mathf.Max(0, start); ev.autoNotes = auto;
                EditorUtility.SetDirty(chart);
            }
            EditorGUILayout.BeginHorizontal();
            if (GUILayout.Button("Align start to grid", GUILayout.Width(130)))
            {
                Undo.RecordObject(chart, "Align Clip Event");
                ev.startSec = chart.Snap(ev.startSec, 1);
                EditorUtility.SetDirty(chart);
            }
            if (GUILayout.Button("Bake anchors → notes", GUILayout.Width(150)))
                BakeEvent(_selEvent);
            if (ev.clip != null && GUILayout.Button("Use clip BPM for chart", GUILayout.Width(150)))
            {
                Undo.RecordObject(chart, "Use Clip BPM");
                chart.bpm = ev.clip.bpm;
                EditorUtility.SetDirty(chart);
            }
            EditorGUILayout.EndHorizontal();
        }

        void DrawNoteInspector(ChartNote n)
        {
            GUILayout.Label("Note", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            float tm = EditorGUILayout.FloatField("Time (s)", n.timeSec, GUILayout.MaxWidth(240));
            bool acc = EditorGUILayout.Toggle("Accent", n.accent, GUILayout.MaxWidth(240));
            if (EditorGUI.EndChangeCheck())
            {
                Undo.RecordObject(chart, "Edit Note");
                n.timeSec = Mathf.Max(0, tm); n.accent = acc;
                EditorUtility.SetDirty(chart);
            }
            GUILayout.Label($"beat {chart.TimeToBeat(n.timeSec):0.00}", EditorStyles.miniLabel);
        }

        void DrawJudgementRow()
        {
            EditorGUILayout.BeginHorizontal();
            EditorGUI.BeginChangeCheck();
            float p = EditorGUILayout.FloatField("Perfect ±s", chart.perfectWindow, GUILayout.MaxWidth(200));
            float g = EditorGUILayout.FloatField("Good ±s", chart.goodWindow, GUILayout.MaxWidth(200));
            int cards = EditorGUILayout.IntField("Cards", chart.startingCards, GUILayout.MaxWidth(160));
            int perMiss = EditorGUILayout.IntField("Drop/miss", chart.cardsPerMiss, GUILayout.MaxWidth(160));
            if (EditorGUI.EndChangeCheck())
            {
                Undo.RecordObject(chart, "Edit Judgement");
                chart.perfectWindow = Mathf.Clamp(p, 0.01f, 0.2f);
                chart.goodWindow = Mathf.Clamp(g, chart.perfectWindow, 0.4f);
                chart.startingCards = Mathf.Max(1, cards);
                chart.cardsPerMiss = Mathf.Max(1, perMiss);
                EditorUtility.SetDirty(chart);
            }
            EditorGUILayout.EndHorizontal();
        }

        // ---------------------------------------------------------------- transport & keys

        void SetPlayhead(float t)
        {
            _playhead = t;
            if (_audio.IsPlaying) _audio.Seek(t);
        }

        void TogglePlay()
        {
            if (_audio.IsPlaying) { _audio.Stop(); _playhead = _audio.Time; }
            else _audio.Play(chart.song, _playhead, _speed, GridBeatAt);
        }

        void HandleKeys()
        {
            var e = Event.current;
            if (e.type != EventType.KeyDown || chart == null) return;
            float step = chart.SecPerBeat / _snapDiv * (e.shift ? 4f : 1f);
            switch (e.keyCode)
            {
                case KeyCode.Space: TogglePlay(); e.Use(); break;
                case KeyCode.B:
                    Undo.RecordObject(chart, "Add Note");
                    chart.manualNotes.Add(new ChartNote { timeSec = MaybeSnap(_playhead), accent = e.shift });
                    chart.manualNotes.Sort((a, b) => a.timeSec.CompareTo(b.timeSec));
                    EditorUtility.SetDirty(chart);
                    e.Use(); Repaint(); break;
                case KeyCode.LeftArrow: SetPlayhead(Mathf.Max(0, MaybeSnap(_playhead - step))); e.Use(); Repaint(); break;
                case KeyCode.RightArrow: SetPlayhead(MaybeSnap(_playhead + step)); e.Use(); Repaint(); break;
                case KeyCode.Home: SetPlayhead(0); _scrollX = 0; e.Use(); Repaint(); break;
                case KeyCode.Delete:
                case KeyCode.Backspace:
                    if (_selNote >= 0 && _selNote < chart.manualNotes.Count)
                    {
                        Undo.RecordObject(chart, "Delete Note");
                        chart.manualNotes.RemoveAt(_selNote); _selNote = -1;
                        EditorUtility.SetDirty(chart);
                    }
                    else if (_selEvent >= 0 && _selEvent < chart.clipEvents.Count)
                    {
                        Undo.RecordObject(chart, "Delete Clip Event");
                        chart.clipEvents.RemoveAt(_selEvent); _selEvent = -1;
                        EditorUtility.SetDirty(chart);
                    }
                    e.Use(); Repaint(); break;
            }
        }

        void TestPlay()
        {
            string path = AssetDatabase.GetAssetPath(chart);
            EditorPrefs.SetString("CardBeat.TestChartGuid", AssetDatabase.AssetPathToGUID(path));
            if (Object.FindFirstObjectByType<RhythmGameManager>() == null)
            {
                var go = new GameObject("RhythmGame");
                Undo.RegisterCreatedObjectUndo(go, "Create RhythmGame");
                go.AddComponent<RhythmGameManager>();
            }
            _audio.Stop();
            EditorApplication.EnterPlaymode();
        }
    }
}
