using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// Plays the chart's Card Beat clip events as a sprite sequence driven by the Conductor.
    /// Frame = (songTime - event.start) * fps; retiming is already baked into the frames.
    /// Holds the last frame briefly between events so the performer doesn't blink out.
    /// </summary>
    [RequireComponent(typeof(SpriteRenderer))]
    public class ClipSequencePlayer : MonoBehaviour
    {
        public RhythmChart chart;
        [Tooltip("World height the clip is scaled to fit.")]
        public float fitHeight = 6f;

        SpriteRenderer _sr;
        Sprite _lastSprite;
        CardBeatClipAsset _lastClip;

        void Awake() => _sr = GetComponent<SpriteRenderer>();

        public void Tick(float songTime)
        {
            if (chart == null) return;
            var ev = chart.ActiveClipAt(songTime);
            Sprite sprite = null;
            CardBeatClipAsset clip = null;
            if (ev != null)
            {
                clip = ev.clip;
                sprite = clip.FrameAt(songTime - ev.startSec);
            }
            if (sprite == null) { sprite = _lastSprite; clip = _lastClip; }

            if (sprite != null && sprite != _sr.sprite)
            {
                _sr.sprite = sprite;
                if (clip != _lastClip && clip != null) FitToHeight(sprite);
                _lastSprite = sprite;
                _lastClip = clip;
            }
        }

        void FitToHeight(Sprite s)
        {
            float h = s.bounds.size.y;
            float k = h > 1e-4f ? fitHeight / h : 1f;
            transform.localScale = new Vector3(k, k, 1f);
        }
    }
}
