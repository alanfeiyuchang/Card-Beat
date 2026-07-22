using System.Collections.Generic;
using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// The diegetic miss feedback: cards visibly tumble out of the performer's hands.
    /// Pure transform animation (no physics components) — spawn, arc, spin, fade, recycle.
    /// </summary>
    public class CardDropEffect : MonoBehaviour
    {
        class Falling
        {
            public Transform t;
            public SpriteRenderer sr;
            public Vector3 vel;
            public float spin;
            public float life;
        }

        readonly List<Falling> _active = new List<Falling>();
        readonly Stack<Falling> _pool = new Stack<Falling>();

        public void Drop(Vector3 from, int count)
        {
            for (int i = 0; i < count; i++)
            {
                var f = _pool.Count > 0 ? _pool.Pop() : Create();
                f.t.gameObject.SetActive(true);
                f.t.position = from + new Vector3(Random.Range(-0.4f, 0.4f), Random.Range(-0.2f, 0.2f), 0f);
                f.t.rotation = Quaternion.Euler(0, 0, Random.Range(-30f, 30f));
                f.vel = new Vector3(Random.Range(-2.5f, 2.5f), Random.Range(2f, 5f), 0f);
                f.spin = Random.Range(-360f, 360f);
                f.life = 0f;
                f.sr.color = Color.white;
                _active.Add(f);
            }
        }

        Falling Create()
        {
            var go = new GameObject("FallingCard");
            go.transform.SetParent(transform, false);
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = RuntimeSprites.Card();
            sr.sortingOrder = 50;
            go.transform.localScale = Vector3.one * 0.9f;
            return new Falling { t = go.transform, sr = sr };
        }

        void Update()
        {
            float dt = Time.deltaTime;
            for (int i = _active.Count - 1; i >= 0; i--)
            {
                var f = _active[i];
                f.life += dt;
                f.vel += Vector3.down * 12f * dt;
                f.t.position += f.vel * dt;
                f.t.Rotate(0, 0, f.spin * dt);
                if (f.life > 1.2f)
                    f.sr.color = new Color(1, 1, 1, Mathf.Clamp01(1.8f - f.life) / 0.6f);
                if (f.life > 1.8f || f.t.position.y < -8f)
                {
                    f.t.gameObject.SetActive(false);
                    _active.RemoveAt(i);
                    _pool.Push(f);
                }
            }
        }
    }
}
