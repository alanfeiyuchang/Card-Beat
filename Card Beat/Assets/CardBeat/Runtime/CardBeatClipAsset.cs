using System;
using System.Collections.Generic;
using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// An imported Card Beat clip package: the baked (beat-retimed) frame sequence plus its
    /// timing metadata from cardbeat.json v2. All times are in OUTPUT-clip seconds — the
    /// retiming is already baked into the frames by the exporter, so frame i is simply t*fps.
    /// </summary>
    [CreateAssetMenu(menuName = "Card Beat/Clip Asset", fileName = "NewCardBeatClip")]
    public class CardBeatClipAsset : ScriptableObject
    {
        [Header("Source")]
        public string sourceName;
        public int width;
        public int height;

        [Header("Frames (baked retimed sequence)")]
        public float fps = 30f;
        public Sprite[] frames = Array.Empty<Sprite>();

        [Header("Beat timing (output-clip seconds)")]
        [Tooltip("Every beat point in the clip, in output seconds.")]
        public float[] beatsSec = Array.Empty<float>();
        [Tooltip("True where the beat is an anchor (a move-impact moment).")]
        public bool[] beatsAccent = Array.Empty<bool>();
        public float secondsPerBeat = 0.5f;
        public float bpm = 120f;

        [Header("Per-object layers (optional, from SAM masks)")]
        public ClipLayerInfo[] layers = Array.Empty<ClipLayerInfo>();

        public float DurationSec => frames.Length / Mathf.Max(1e-4f, fps);

        /// <summary>Anchor (accented beat) times in output-clip seconds — the hit moments.</summary>
        public List<float> AnchorTimes()
        {
            var list = new List<float>();
            bool hasAccents = beatsAccent != null && beatsAccent.Length == beatsSec.Length;
            for (int i = 0; i < beatsSec.Length; i++)
                if (!hasAccents || beatsAccent[i])
                    list.Add(beatsSec[i]);
            return list;
        }

        /// <summary>All beat times (accented or not) in output-clip seconds.</summary>
        public IReadOnlyList<float> BeatTimes() => beatsSec;

        public Sprite FrameAt(float clipTimeSec)
        {
            if (frames == null || frames.Length == 0) return null;
            int i = Mathf.Clamp(Mathf.FloorToInt(clipTimeSec * fps), 0, frames.Length - 1);
            return frames[i];
        }
    }

    [Serializable]
    public class ClipLayerInfo
    {
        public string name;
        public string maskDir;
        public Color tint = Color.white;
        public Sprite[] maskFrames = Array.Empty<Sprite>();
    }
}
