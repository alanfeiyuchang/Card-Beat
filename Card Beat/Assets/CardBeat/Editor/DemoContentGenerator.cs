using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace CardBeat.EditorTools
{
    /// <summary>
    /// One-click demo content so the pipeline is testable before a real Card Beat export
    /// exists: builds a synthetic *cardbeat package* (toon-styled card-dealing frames + a
    /// card mask layer + cardbeat.json) and runs it through the real importer, bakes a
    /// procedural backing track to WAV, and assembles a ready-to-play demo chart.
    /// </summary>
    public static class DemoContentGenerator
    {
        const int W = 256, H = 384;
        const float Fps = 30f;
        const float Bpm = 100f;
        const int ClipBeats = 16;   // clip length in beats; a card lands every 2 beats

        [MenuItem("Card Beat/Create Demo Content (song + clip + chart)")]
        public static void Create()
        {
            float spb = 60f / Bpm;

            // 1. synthetic cardbeat package → real importer (doubles as an importer test)
            string pkg = Path.Combine(Path.GetTempPath(), "cardbeat_demo_pkg");
            if (Directory.Exists(pkg)) Directory.Delete(pkg, true);
            Directory.CreateDirectory(Path.Combine(pkg, "frames"));
            Directory.CreateDirectory(Path.Combine(pkg, "masks", "card"));
            int frameCount = Mathf.RoundToInt(ClipBeats * spb * Fps);
            WriteFrames(pkg, frameCount, spb);
            File.WriteAllText(Path.Combine(pkg, "cardbeat.json"), BuildJson(frameCount, spb));

            CardBeatClipAsset clip;
            try
            {
                clip = CardBeatImporter.Import(pkg, "DemoClip");
            }
            finally
            {
                Directory.Delete(pkg, true);
            }

            // 2. demo song WAV
            if (!AssetDatabase.IsValidFolder("Assets/CardBeatDemo"))
                AssetDatabase.CreateFolder("Assets", "CardBeatDemo");
            const int songBeats = 64;
            WavWriter.Write(Path.GetFullPath("Assets/CardBeatDemo/DemoSong.wav"),
                AudioSynth.DemoSongSamples(Bpm, songBeats), AudioSynth.Rate);
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var song = AssetDatabase.LoadAssetAtPath<AudioClip>("Assets/CardBeatDemo/DemoSong.wav");

            // 3. chart: the clip repeated back-to-back over the song
            var chart = ScriptableObject.CreateInstance<RhythmChart>();
            chart.song = song;
            chart.bpm = Bpm;
            chart.offsetSec = 0f;
            float clipDur = ClipBeats * spb;
            for (float t = 0; t + clipDur <= songBeats * spb + 0.01f; t += clipDur)
                chart.clipEvents.Add(new ClipEvent { clip = clip, startSec = t });
            AssetDatabase.CreateAsset(chart, "Assets/CardBeatDemo/DemoChart.asset");
            AssetDatabase.SaveAssets();

            Selection.activeObject = chart;
            Debug.Log($"[Card Beat] Demo content ready: {clip.frames.Length}-frame clip, " +
                      $"{song.length:0.0}s song, chart with {chart.clipEvents.Count} clip events / " +
                      $"{chart.BuildNoteList().Count} notes. Opening the Chart Editor…");
            ChartEditorWindow.Open();
        }

        // ------------------------------------------------------------ frames

        static void WriteFrames(string pkg, int frameCount, float spb)
        {
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            var maskTex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            var px = new Color32[W * H];
            var mask = new Color32[W * H];
            try
            {
                for (int f = 0; f < frameCount; f++)
                {
                    if (f % 20 == 0)
                        EditorUtility.DisplayProgressBar("Card Beat demo", "drawing frames", f / (float)frameCount);
                    DrawFrame(px, mask, f / Fps, spb);
                    tex.SetPixels32(px); tex.Apply();
                    maskTex.SetPixels32(mask); maskTex.Apply();
                    File.WriteAllBytes(Path.Combine(pkg, "frames", $"frame_{f:0000}.png"), tex.EncodeToPNG());
                    File.WriteAllBytes(Path.Combine(pkg, "masks", "card", $"frame_{f:0000}.png"), maskTex.EncodeToPNG());
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                Object.DestroyImmediate(tex);
                Object.DestroyImmediate(maskTex);
            }
        }

        /// <summary>
        /// Toon placeholder performer: a hand at the bottom holding a fan; every 2 beats a
        /// card flies out and lands on the "table" exactly on the anchor beat (the impact).
        /// </summary>
        static void DrawFrame(Color32[] px, Color32[] mask, float t, float spb)
        {
            var clear = new Color32(0, 0, 0, 0);
            for (int i = 0; i < px.Length; i++) { px[i] = clear; mask[i] = clear; }

            var skin = new Color32(242, 194, 153, 255);
            var ink = new Color32(20, 16, 24, 255);
            var cardFace = new Color32(250, 250, 245, 255);
            var cardRed = new Color32(199, 31, 41, 255);

            // hand
            FillEllipse(px, W / 2, (int)(H * 0.82f), 66, 46, skin, ink);

            // held fan (static)
            for (int c = -2; c <= 2; c++)
            {
                int cx = W / 2 + c * 18;
                int cy = (int)(H * 0.72f) + Mathf.Abs(c) * 4;
                FillCard(px, null, cx, cy, 30, 44, cardFace, ink);
            }

            // dealt cards: card k impacts at anchor time k*2*spb (k = 1..7)
            int deals = ClipBeats / 2 - 1;
            for (int k = 1; k <= deals; k++)
            {
                float impact = k * 2f * spb;
                float start = impact - 1.2f * spb;              // flight time
                int targetX = (int)(W * (0.14f + 0.72f * ((k - 1) / (float)(deals - 1))));
                int targetY = (int)(H * 0.22f);
                if (t >= impact)
                {
                    FillCard(px, null, targetX, targetY, 34, 48, cardFace, ink, cardRed);
                }
                else if (t >= start)
                {
                    float u = (t - start) / (impact - start);
                    u = u * u * (3f - 2f * u);                  // smoothstep — snaps into place at the beat
                    int x = (int)Mathf.Lerp(W / 2f, targetX, u);
                    int y = (int)(Mathf.Lerp(H * 0.72f, targetY, u) - Mathf.Sin(u * Mathf.PI) * H * 0.10f);
                    FillCard(px, mask, x, y, 34, 48, cardFace, ink, cardRed);
                }
            }
        }

        static void FillEllipse(Color32[] px, int cx, int cy, int rx, int ry, Color32 fill, Color32 outline)
        {
            for (int y = cy - ry - 3; y <= cy + ry + 3; y++)
                for (int x = cx - rx - 3; x <= cx + rx + 3; x++)
                {
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    float d = Sq((x - cx) / (float)rx) + Sq((y - cy) / (float)ry);
                    float dOut = Sq((x - cx) / (rx + 3f)) + Sq((y - cy) / (ry + 3f));
                    if (d <= 1f) px[Idx(x, y)] = fill;
                    else if (dOut <= 1f) px[Idx(x, y)] = outline;
                }
        }

        static void FillCard(Color32[] px, Color32[] mask, int cx, int cy, int w, int h,
            Color32 face, Color32 ink, Color32? pip = null)
        {
            var white = new Color32(255, 255, 255, 255);
            for (int y = cy - h / 2 - 2; y <= cy + h / 2 + 2; y++)
                for (int x = cx - w / 2 - 2; x <= cx + w / 2 + 2; x++)
                {
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    bool inCard = Mathf.Abs(x - cx) <= w / 2 && Mathf.Abs(y - cy) <= h / 2;
                    bool inBorder = Mathf.Abs(x - cx) <= w / 2 + 2 && Mathf.Abs(y - cy) <= h / 2 + 2;
                    if (inCard)
                    {
                        bool isPip = pip.HasValue &&
                            Sq(x - cx) + Sq((y - cy) * 0.8f) < Sq(w * 0.22f);
                        px[Idx(x, y)] = isPip ? pip.Value : face;
                        if (mask != null) mask[Idx(x, y)] = white;
                    }
                    else if (inBorder) px[Idx(x, y)] = ink;
                }
        }

        static int Idx(int x, int y) => y * W + x;   // note: y=0 is the PNG bottom in Unity
        static float Sq(float v) => v * v;

        // ------------------------------------------------------------ json

        static string BuildJson(int frameCount, float spb)
        {
            var inv = CultureInfo.InvariantCulture;
            var beats = new StringBuilder();
            var accents = new StringBuilder();
            for (int i = 0; i < ClipBeats; i++)
            {
                if (i > 0) { beats.Append(", "); accents.Append(", "); }
                beats.Append((i * spb).ToString("0.####", inv));
                bool anchor = i >= 2 && i % 2 == 0;   // a deal lands every 2 beats
                accents.Append(anchor ? "true" : "false");
            }
            return
"{\n" +
"  \"tool\": \"Card Beat\",\n" +
"  \"version\": 2,\n" +
"  \"source\": \"demo_deal.mp4\",\n" +
$"  \"output\": {{ \"width\": {W}, \"height\": {H}, \"fps\": {Fps.ToString("0.##", inv)}, \"frameCount\": {frameCount}, \"format\": \"png-sequence-rgba\" }},\n" +
$"  \"durationOutSec\": {(ClipBeats * spb).ToString("0.####", inv)},\n" +
$"  \"beat\": {{ \"secondsPerBeat\": {spb.ToString("0.####", inv)}, \"bpm\": {Bpm.ToString("0.###", inv)}, \"anchorsSrcSec\": [], \"anchorsOutSec\": [], \"segments\": [] }},\n" +
$"  \"beatsSec\": [{beats}],\n" +
$"  \"beatsAccent\": [{accents}],\n" +
"  \"layers\": [ { \"name\": \"card\", \"slug\": \"card\", \"maskDir\": \"masks/card\", \"style\": { \"tint\": \"#ff5566\" } } ]\n" +
"}\n";
        }
    }
}
