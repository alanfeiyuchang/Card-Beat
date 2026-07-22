using System.Collections.Generic;
using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// Procedural sprites so the game needs no hand-authored art assets:
    /// playing-card back (for the miss "cards drop" effect), filled/ring circles
    /// (note lane markers and hit target), and a soft square.
    /// </summary>
    public static class RuntimeSprites
    {
        static readonly Dictionary<string, Sprite> _cache = new Dictionary<string, Sprite>();

        public static Sprite Card(int w = 64, int h = 90)
        {
            const string key = "card";
            if (_cache.TryGetValue(key, out var s)) return s;
            var tex = NewTex(w, h);
            var back = new Color(0.78f, 0.12f, 0.16f);
            var backDark = new Color(0.62f, 0.08f, 0.12f);
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    if (!InRoundedRect(x, y, w, h, 8)) { tex.SetPixel(x, y, Color.clear); continue; }
                    bool border = !InRoundedRect(x, y, w, h, 8, 4);
                    bool diamond = ((x / 8) + (y / 8)) % 2 == 0;
                    tex.SetPixel(x, y, border ? Color.white : (diamond ? back : backDark));
                }
            tex.Apply();
            return _cache[key] = Sprite.Create(tex, new Rect(0, 0, w, h), new Vector2(0.5f, 0.5f), 100f);
        }

        public static Sprite Circle(bool filled, int d = 64, float ringFrac = 0.12f)
        {
            string key = (filled ? "disc" : "ring") + d;
            if (_cache.TryGetValue(key, out var s)) return s;
            var tex = NewTex(d, d);
            float r = d * 0.5f - 1f, ring = d * ringFrac;
            for (int y = 0; y < d; y++)
                for (int x = 0; x < d; x++)
                {
                    float dist = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(d / 2f, d / 2f));
                    float a = filled
                        ? Mathf.Clamp01(r - dist)
                        : Mathf.Clamp01(ring * 0.5f - Mathf.Abs(dist - (r - ring * 0.5f)) + 0.5f);
                    tex.SetPixel(x, y, new Color(1f, 1f, 1f, a));
                }
            tex.Apply();
            return _cache[key] = Sprite.Create(tex, new Rect(0, 0, d, d), new Vector2(0.5f, 0.5f), 100f);
        }

        public static Sprite Square()
        {
            const string key = "square";
            if (_cache.TryGetValue(key, out var s)) return s;
            var tex = NewTex(4, 4);
            for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) tex.SetPixel(x, y, Color.white);
            tex.Apply();
            return _cache[key] = Sprite.Create(tex, new Rect(0, 0, 4, 4), new Vector2(0.5f, 0.5f), 4f);
        }

        static Texture2D NewTex(int w, int h) =>
            new Texture2D(w, h, TextureFormat.RGBA32, false)
            { filterMode = FilterMode.Bilinear, hideFlags = HideFlags.HideAndDontSave };

        static bool InRoundedRect(int x, int y, int w, int h, int r, int inset = 0)
        {
            int x0 = inset, y0 = inset, x1 = w - 1 - inset, y1 = h - 1 - inset;
            if (x < x0 || y < y0 || x > x1 || y > y1) return false;
            int rr = r;
            int cx = x < x0 + rr ? x0 + rr : (x > x1 - rr ? x1 - rr : x);
            int cy = y < y0 + rr ? y0 + rr : (y > y1 - rr ? y1 - rr : y);
            return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= rr * rr;
        }
    }
}
