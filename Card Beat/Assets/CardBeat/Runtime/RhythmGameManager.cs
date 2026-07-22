using UnityEngine;
using UnityEngine.InputSystem;

namespace CardBeat
{
    /// <summary>
    /// Bootstraps and runs the whole rhythm game from a RhythmChart: builds the conductor,
    /// clip player, note lane, HUD and card-drop feedback in code, so the scene only needs a
    /// camera and this one component. R restarts, F1 toggles autoplay, 1/2/3 set practice speed.
    /// </summary>
    public class RhythmGameManager : MonoBehaviour
    {
        public RhythmChart chart;
        public bool autoplay;
        [Range(0.25f, 1f)] public float practiceSpeed = 1f;

        Conductor _conductor;
        ClipSequencePlayer _player;
        JudgementSystem _judge;
        NoteLane _lane;
        GameHUD _hud;
        CardDropEffect _drops;

        int _cardsLeft;
        bool _finished;

        /// <summary>Set by the chart editor's Test Play before entering play mode.</summary>
        public static string testChartGuid;

        void Awake()
        {
            ResolveChart();
            SetupCamera();

            _conductor = new GameObject("Conductor", typeof(AudioSource), typeof(Conductor)).GetComponent<Conductor>();
            _conductor.transform.SetParent(transform, false);

            _player = new GameObject("ClipPlayer", typeof(SpriteRenderer), typeof(ClipSequencePlayer)).GetComponent<ClipSequencePlayer>();
            _player.transform.SetParent(transform, false);
            _player.transform.position = new Vector3(0, -0.6f, 0);
            _player.chart = chart;

            _judge = gameObject.AddComponent<JudgementSystem>();
            _drops = new GameObject("CardDrops", typeof(CardDropEffect)).GetComponent<CardDropEffect>();
            _drops.transform.SetParent(transform, false);

            _lane = new GameObject("NoteLane", typeof(NoteLane)).GetComponent<NoteLane>();
            _lane.transform.SetParent(transform, false);

            _hud = gameObject.AddComponent<GameHUD>();
            _hud.Build();

            _judge.OnJudged += HandleJudged;

            if (chart != null) StartRun();
            else _hud.SetStatus("No chart assigned — set one on RhythmGameManager");
        }

        void ResolveChart()
        {
#if UNITY_EDITOR
            if (chart == null && !string.IsNullOrEmpty(testChartGuid))
            {
                string path = UnityEditor.AssetDatabase.GUIDToAssetPath(testChartGuid);
                if (!string.IsNullOrEmpty(path))
                    chart = UnityEditor.AssetDatabase.LoadAssetAtPath<RhythmChart>(path);
            }
            if (chart == null)
            {
                string pref = UnityEditor.EditorPrefs.GetString("CardBeat.TestChartGuid", "");
                if (!string.IsNullOrEmpty(pref))
                    chart = UnityEditor.AssetDatabase.LoadAssetAtPath<RhythmChart>(
                        UnityEditor.AssetDatabase.GUIDToAssetPath(pref));
            }
#endif
        }

        void SetupCamera()
        {
            var cam = Camera.main;
            if (cam == null)
            {
                cam = new GameObject("Main Camera", typeof(Camera), typeof(AudioListener)).GetComponent<Camera>();
                cam.tag = "MainCamera";
            }
            cam.orthographic = true;
            cam.orthographicSize = 5f;
            cam.transform.position = new Vector3(0, 0, -10);
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.09f, 0.07f, 0.13f);
        }

        void StartRun()
        {
            _finished = false;
            _hud.HideResults();
            _judge.autoplay = autoplay;
            _judge.Begin(chart);
            _lane.Init(_judge);
            _cardsLeft = chart.startingCards;
            _hud.SetCards(_cardsLeft, chart.startingCards);
            _hud.SetScore(0);
            _hud.SetCombo(0);
            _conductor.StartSong(chart.song, chart.leadInSec, practiceSpeed);
            UpdateStatus();
        }

        void HandleJudged(ChartNote note, Judgement j, float delta)
        {
            _hud.ShowJudgement(j, delta);
            _hud.SetScore(_judge.Score);
            _hud.SetCombo(_judge.Combo);
            if (j == Judgement.Miss)
            {
                _cardsLeft = Mathf.Max(0, _cardsLeft - chart.cardsPerMiss);
                _hud.SetCards(_cardsLeft, chart.startingCards);
                _drops.Drop(_player.transform.position + Vector3.up * 0.5f, chart.cardsPerMiss);
            }
        }

        void UpdateStatus()
        {
            string s = "";
            if (autoplay) s += "AUTOPLAY (F1)  ";
            if (practiceSpeed < 0.999f) s += $"speed ×{practiceSpeed:0.##} (1/2/3)  ";
            s += "space — hit · R — retry";
            _hud.SetStatus(s);
        }

        void Update()
        {
            var kb = Keyboard.current;
            if (kb != null)
            {
                if (kb.rKey.wasPressedThisFrame) { Restart(); return; }
                if (kb.f1Key.wasPressedThisFrame) { autoplay = !autoplay; _judge.autoplay = autoplay; UpdateStatus(); }
                if (kb.digit1Key.wasPressedThisFrame) SetSpeed(0.5f);
                if (kb.digit2Key.wasPressedThisFrame) SetSpeed(0.75f);
                if (kb.digit3Key.wasPressedThisFrame) SetSpeed(1f);
            }

            if (chart == null || _finished) return;

            float t = _conductor.SongTime;
            _judge.Tick(t);
            _player.Tick(t);
            _lane.Tick(t);
            _hud.SetProgress(t / Mathf.Max(0.01f, chart.SongLength));

            float end = Mathf.Max(chart.SongLength, chart.EndOfContent());
            if (_conductor.SongEnded(end) || (_judge.TotalNotes > 0 && _judge.JudgedCount == _judge.TotalNotes && t > end))
                Finish();
        }

        void SetSpeed(float s)
        {
            practiceSpeed = s;
            Restart();
        }

        void Restart()
        {
            _conductor.Stop();
            if (chart != null) StartRun();
        }

        void Finish()
        {
            _finished = true;
            _conductor.Stop();
            _hud.ShowResults(_judge, _cardsLeft, chart.startingCards);
        }
    }
}
