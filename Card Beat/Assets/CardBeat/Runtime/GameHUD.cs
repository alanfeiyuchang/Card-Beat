using UnityEngine;
using UnityEngine.UI;

namespace CardBeat
{
    /// <summary>
    /// Programmatic uGUI HUD — score, combo, judgement popup, cards remaining, song progress,
    /// and a results panel. Built entirely in code so the scene needs no authored canvas.
    /// </summary>
    public class GameHUD : MonoBehaviour
    {
        Text _score, _combo, _judgement, _cards, _status;
        Image _progressFill;
        GameObject _results;
        Text _resultsText;
        float _judgementAge;

        static Font UIFont => Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        public void Build()
        {
            var canvasGo = new GameObject("Canvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGo.transform.SetParent(transform, false);
            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1600, 900);

            _score = MakeText(canvasGo, "Score", "0", 44, TextAnchor.UpperRight,
                new Vector2(1, 1), new Vector2(-30, -24), new Vector2(400, 60));
            _cards = MakeText(canvasGo, "Cards", "", 34, TextAnchor.UpperLeft,
                new Vector2(0, 1), new Vector2(30, -24), new Vector2(500, 50));
            _combo = MakeText(canvasGo, "Combo", "", 38, TextAnchor.MiddleCenter,
                new Vector2(0.5f, 1), new Vector2(0, -150), new Vector2(400, 54));
            _combo.color = new Color(1f, 0.85f, 0.2f);
            _judgement = MakeText(canvasGo, "Judgement", "", 64, TextAnchor.MiddleCenter,
                new Vector2(0.5f, 0.5f), new Vector2(0, 140), new Vector2(600, 90));
            _status = MakeText(canvasGo, "Status", "", 26, TextAnchor.LowerRight,
                new Vector2(1, 0), new Vector2(-30, 20), new Vector2(600, 40));
            _status.color = new Color(1, 1, 1, 0.55f);

            // progress bar
            var barBg = MakeImage(canvasGo, "ProgressBg", new Color(1, 1, 1, 0.12f),
                new Vector2(0.5f, 0), new Vector2(0, 16), new Vector2(1200, 8));
            _progressFill = MakeImage(barBg.gameObject, "ProgressFill", new Color(0.4f, 0.8f, 1f, 0.9f),
                new Vector2(0, 0.5f), Vector2.zero, new Vector2(0, 8));
            var fr = _progressFill.rectTransform;
            fr.anchorMin = new Vector2(0, 0); fr.anchorMax = new Vector2(0, 1);
            fr.pivot = new Vector2(0, 0.5f); fr.anchoredPosition = Vector2.zero;

            // results panel (hidden until song end)
            _results = new GameObject("Results");
            _results.transform.SetParent(canvasGo.transform, false);
            var panel = MakeImage(_results, "Panel", new Color(0f, 0f, 0f, 0.82f),
                new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(700, 460));
            _resultsText = MakeText(panel.gameObject, "Text", "", 34, TextAnchor.MiddleCenter,
                new Vector2(0.5f, 0.5f), Vector2.zero, new Vector2(640, 420));
            _results.SetActive(false);
        }

        static Text MakeText(GameObject parent, string name, string content, int size,
            TextAnchor anchor, Vector2 anchorPoint, Vector2 pos, Vector2 sz)
        {
            var go = new GameObject(name, typeof(Text), typeof(Outline));
            go.transform.SetParent(parent.transform, false);
            var t = go.GetComponent<Text>();
            t.font = UIFont;
            t.text = content;
            t.fontSize = size;
            t.alignment = anchor;
            t.color = Color.white;
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            go.GetComponent<Outline>().effectColor = new Color(0, 0, 0, 0.8f);
            var rt = t.rectTransform;
            rt.anchorMin = rt.anchorMax = rt.pivot = anchorPoint;
            rt.anchoredPosition = pos;
            rt.sizeDelta = sz;
            return t;
        }

        static Image MakeImage(GameObject parent, string name, Color color,
            Vector2 anchorPoint, Vector2 pos, Vector2 sz)
        {
            var go = new GameObject(name, typeof(Image));
            go.transform.SetParent(parent.transform, false);
            var img = go.GetComponent<Image>();
            img.color = color;
            var rt = img.rectTransform;
            rt.anchorMin = rt.anchorMax = rt.pivot = anchorPoint;
            rt.anchoredPosition = pos;
            rt.sizeDelta = sz;
            return img;
        }

        public void SetScore(int score) => _score.text = score.ToString("N0");
        public void SetCards(int remaining, int total) => _cards.text = $"🂠 {remaining} / {total} cards";
        public void SetCombo(int combo) => _combo.text = combo >= 2 ? $"{combo} COMBO" : "";
        public void SetStatus(string s) => _status.text = s;
        public void SetProgress(float t01)
        {
            var rt = _progressFill.rectTransform;
            rt.sizeDelta = new Vector2(0, rt.sizeDelta.y);
            rt.anchorMax = new Vector2(Mathf.Clamp01(t01), 1);
        }

        public void ShowJudgement(Judgement j, float delta)
        {
            _judgementAge = 0f;
            switch (j)
            {
                case Judgement.Perfect: _judgement.text = "PERFECT"; _judgement.color = new Color(1f, 0.85f, 0.2f); break;
                case Judgement.Good:
                    _judgement.text = delta < 0 ? "GOOD (early)" : "GOOD (late)";
                    _judgement.color = new Color(0.4f, 0.9f, 0.5f); break;
                case Judgement.Miss: _judgement.text = "MISS"; _judgement.color = new Color(1f, 0.35f, 0.3f); break;
            }
            _judgement.transform.localScale = Vector3.one * 1.25f;
        }

        public void ShowResults(JudgementSystem judge, int cardsLeft, int cardsTotal)
        {
            _results.SetActive(true);
            string grade = cardsLeft <= 0 ? "DROPPED THE DECK" :
                judge.Accuracy > 0.95f ? "S" : judge.Accuracy > 0.9f ? "A" :
                judge.Accuracy > 0.8f ? "B" : judge.Accuracy > 0.65f ? "C" : "D";
            _resultsText.text =
                $"<b>{grade}</b>\n\n" +
                $"Cards kept: {cardsLeft} / {cardsTotal}\n" +
                $"Score: {judge.Score:N0}\n" +
                $"Perfect {judge.PerfectCount} · Good {judge.GoodCount} · Miss {judge.MissCount}\n" +
                $"Max combo: {judge.MaxCombo}\n" +
                $"Accuracy: {judge.Accuracy:P1}\n\n" +
                "R — retry";
        }

        public void HideResults() => _results.SetActive(false);

        void Update()
        {
            if (string.IsNullOrEmpty(_judgement.text)) return;
            _judgementAge += Time.deltaTime;
            _judgement.transform.localScale =
                Vector3.one * Mathf.Lerp(_judgement.transform.localScale.x, 1f, Time.deltaTime * 10f);
            if (_judgementAge > 0.6f)
            {
                var c = _judgement.color;
                c.a = Mathf.Clamp01(1f - (_judgementAge - 0.6f) * 3f);
                _judgement.color = c;
                if (c.a <= 0f) _judgement.text = "";
            }
        }
    }
}
