using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// Tiny procedural audio: metronome clicks and a demo backing track, so the editor and
    /// game are testable before any real song asset exists.
    /// </summary>
    public static class AudioSynth
    {
        public const int Rate = 44100;

        /// <summary>A short click; accented clicks are higher-pitched.</summary>
        public static AudioClip Click(bool accent)
        {
            float freq = accent ? 1568f : 1046.5f;
            int n = Rate / 20; // 50 ms
            var data = new float[n];
            for (int i = 0; i < n; i++)
            {
                float t = i / (float)Rate;
                float env = Mathf.Exp(-t * 60f);
                data[i] = Mathf.Sin(2f * Mathf.PI * freq * t) * env * 0.5f;
            }
            var clip = AudioClip.Create(accent ? "ClickAccent" : "Click", n, 1, Rate, false);
            clip.SetData(data, 0);
            return clip;
        }

        /// <summary>
        /// Generate raw samples for a kick/hat/snare backing loop at the given bpm.
        /// Pattern per beat: kick on the beat, hat on the offbeat, snare every 4th beat.
        /// </summary>
        public static float[] DemoSongSamples(float bpm, int beats)
        {
            float spb = 60f / bpm;
            int total = Mathf.CeilToInt(beats * spb * Rate);
            var data = new float[total];
            var rng = new System.Random(1234);

            for (int b = 0; b < beats; b++)
            {
                AddKick(data, b * spb);
                AddHat(data, (b + 0.5f) * spb, rng);
                if (b % 4 == 2) AddSnare(data, b * spb, rng);
                if (b % 8 == 7) AddHat(data, (b + 0.75f) * spb, rng);
            }
            // gentle bass drone so it reads as music, not just percussion
            for (int i = 0; i < total; i++)
            {
                float t = i / (float)Rate;
                int beat = (int)(t / spb);
                float root = (beat / 4) % 2 == 0 ? 55f : 41.2f; // A1 / E1
                data[i] += 0.10f * Mathf.Sin(2f * Mathf.PI * root * t) * (0.6f + 0.4f * Mathf.Cos(2f * Mathf.PI * (t % spb) / spb));
                data[i] = Mathf.Clamp(data[i], -1f, 1f);
            }
            return data;
        }

        static void AddKick(float[] d, float at)
        {
            int s = (int)(at * Rate);
            int n = Rate / 8;
            for (int i = 0; i < n && s + i < d.Length; i++)
            {
                float t = i / (float)Rate;
                float f = Mathf.Lerp(120f, 45f, t * 8f);
                d[s + i] += Mathf.Sin(2f * Mathf.PI * f * t) * Mathf.Exp(-t * 22f) * 0.9f;
            }
        }

        static void AddSnare(float[] d, float at, System.Random rng)
        {
            int s = (int)(at * Rate);
            int n = Rate / 10;
            for (int i = 0; i < n && s + i < d.Length; i++)
            {
                float t = i / (float)Rate;
                d[s + i] += ((float)rng.NextDouble() * 2f - 1f) * Mathf.Exp(-t * 30f) * 0.35f;
            }
        }

        static void AddHat(float[] d, float at, System.Random rng)
        {
            int s = (int)(at * Rate);
            int n = Rate / 25;
            for (int i = 0; i < n && s + i < d.Length; i++)
            {
                float t = i / (float)Rate;
                d[s + i] += ((float)rng.NextDouble() * 2f - 1f) * Mathf.Exp(-t * 90f) * 0.18f;
            }
        }
    }
}
