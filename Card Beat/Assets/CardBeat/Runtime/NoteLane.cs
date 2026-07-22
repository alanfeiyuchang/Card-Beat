using System.Collections.Generic;
using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// PaRappa-style approach bar: a fixed hit ring on the left, note discs scroll in from
    /// the right and cross the ring exactly at their note time. Purely visual — judgement
    /// stays in JudgementSystem; this just gives the player something to read.
    /// </summary>
    public class NoteLane : MonoBehaviour
    {
        public float laneY = 4.2f;
        public float hitX = -6.5f;
        public float rightX = 8.5f;
        [Tooltip("Seconds a note takes to cross the lane.")]
        public float approachSec = 2f;

        JudgementSystem _judge;
        readonly Dictionary<int, SpriteRenderer> _markers = new Dictionary<int, SpriteRenderer>();
        readonly Stack<SpriteRenderer> _pool = new Stack<SpriteRenderer>();
        SpriteRenderer _ring;
        float _ringPulse;

        static readonly Color AccentCol = new Color(1f, 0.85f, 0.2f);
        static readonly Color NormalCol = new Color(0.4f, 0.8f, 1f);

        public void Init(JudgementSystem judge)
        {
            _judge = judge;
            _judge.OnJudged += (n, j, d) => { if (j != Judgement.Miss) _ringPulse = 1f; };

            var bar = NewSprite("LaneBar", RuntimeSprites.Square(), new Color(1, 1, 1, 0.10f));
            bar.transform.position = new Vector3((hitX + rightX) * 0.5f, laneY, 1f);
            bar.transform.localScale = new Vector3(rightX - hitX + 1.2f, 0.9f, 1f);
            bar.sortingOrder = 10;

            _ring = NewSprite("HitRing", RuntimeSprites.Circle(false, 96), Color.white);
            _ring.transform.position = new Vector3(hitX, laneY, 0f);
            _ring.transform.localScale = Vector3.one * 1.15f;
            _ring.sortingOrder = 13;
        }

        SpriteRenderer NewSprite(string name, Sprite sprite, Color color)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.color = color;
            return sr;
        }

        public void Tick(float songTime)
        {
            if (_judge == null || _judge.chart == null) return;
            float speed = (rightX - hitX) / approachSec;
            var notes = _judge.Notes;

            for (int i = 0; i < notes.Count; i++)
            {
                float dt = notes[i].timeSec - songTime;
                bool visible = dt <= approachSec && dt >= -0.25f && !_judge.IsJudged(i);
                if (visible)
                {
                    if (!_markers.TryGetValue(i, out var m))
                    {
                        m = _pool.Count > 0 ? _pool.Pop() : NewSprite("Note", RuntimeSprites.Circle(true, 64), Color.white);
                        m.gameObject.SetActive(true);
                        m.sprite = RuntimeSprites.Circle(true, 64);
                        m.sortingOrder = 12;
                        _markers[i] = m;
                    }
                    m.color = notes[i].accent ? AccentCol : NormalCol;
                    m.transform.position = new Vector3(hitX + dt * speed, laneY, 0f);
                    float s = notes[i].accent ? 0.85f : 0.65f;
                    m.transform.localScale = Vector3.one * s;
                }
                else if (_markers.TryGetValue(i, out var m))
                {
                    m.gameObject.SetActive(false);
                    _markers.Remove(i);
                    _pool.Push(m);
                }
            }

            if (_ringPulse > 0f)
            {
                _ringPulse = Mathf.Max(0f, _ringPulse - Time.deltaTime * 4f);
                _ring.transform.localScale = Vector3.one * (1.15f + 0.35f * _ringPulse);
            }
        }
    }
}
