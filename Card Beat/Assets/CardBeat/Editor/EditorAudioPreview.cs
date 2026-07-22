using UnityEditor;
using UnityEngine;

namespace CardBeat.EditorTools
{
    /// <summary>
    /// Edit-mode song playback + metronome for the chart editor: a hidden AudioSource pair
    /// driven off AudioSettings.dspTime, so the editor playhead uses the same clock as the game.
    /// </summary>
    public class EditorAudioPreview
    {
        GameObject _go;
        AudioSource _song, _click;
        AudioClip _clickLo, _clickHi;

        double _dspStart;
        float _startSec;
        float _speed = 1f;

        public bool IsPlaying { get; private set; }
        public bool metronome = true;
        double _nextClickDsp = double.MaxValue;
        int _nextBeat;
        System.Func<int, (float timeSec, bool accent)?> _beatProvider;

        public float Time => IsPlaying ? _startSec + (float)((AudioSettings.dspTime - _dspStart) * _speed) : _startSec;

        void Ensure()
        {
            if (_go != null) return;
            _go = new GameObject("~CardBeatEditorAudio") { hideFlags = HideFlags.HideAndDontSave };
            _song = _go.AddComponent<AudioSource>();
            _click = _go.AddComponent<AudioSource>();
            _song.playOnAwake = _click.playOnAwake = false;
            _clickLo = AudioSynth.Click(false);
            _clickHi = AudioSynth.Click(true);
        }

        /// <summary>beatProvider(i) returns the i-th grid beat (song time, accent) or null past the end.</summary>
        public void Play(AudioClip song, float fromSec, float speed,
            System.Func<int, (float timeSec, bool accent)?> beatProvider)
        {
            Ensure();
            Stop();
            _speed = Mathf.Clamp(speed, 0.25f, 2f);
            _startSec = Mathf.Max(0f, fromSec);
            _dspStart = AudioSettings.dspTime + 0.06;
            _beatProvider = beatProvider;
            if (song != null && _startSec < song.length - 0.05f)
            {
                _song.clip = song;
                _song.pitch = _speed;
                _song.time = _startSec;
                _song.PlayScheduled(_dspStart);
            }
            _nextBeat = 0;
            AdvanceClickPastStart();
            IsPlaying = true;
        }

        void AdvanceClickPastStart()
        {
            _nextClickDsp = double.MaxValue;
            if (_beatProvider == null) return;
            for (int i = 0; i < 100000; i++)
            {
                var b = _beatProvider(i);
                if (b == null) return;
                if (b.Value.timeSec >= _startSec - 1e-4f) { _nextBeat = i; QueueClick(); return; }
            }
        }

        void QueueClick()
        {
            var b = _beatProvider(_nextBeat);
            _nextClickDsp = b == null ? double.MaxValue : _dspStart + (b.Value.timeSec - _startSec) / _speed;
        }

        /// <summary>Call from EditorApplication.update while playing.</summary>
        public void Update()
        {
            if (!IsPlaying || _beatProvider == null) return;
            // schedule the next metronome click just ahead of its dsp time
            while (_nextClickDsp < AudioSettings.dspTime + 0.12)
            {
                var b = _beatProvider(_nextBeat);
                if (b == null) { _nextClickDsp = double.MaxValue; break; }
                if (metronome)
                {
                    _click.clip = b.Value.accent ? _clickHi : _clickLo;
                    _click.PlayScheduled(System.Math.Max(_nextClickDsp, AudioSettings.dspTime));
                }
                _nextBeat++;
                QueueClick();
            }
        }

        public void Stop()
        {
            if (_go == null) return;
            _startSec = Time;
            _song.Stop();
            _click.Stop();
            IsPlaying = false;
            _nextClickDsp = double.MaxValue;
        }

        public void Seek(float sec)
        {
            bool was = IsPlaying;
            var clip = _song != null ? _song.clip : null;
            if (was) Stop();
            _startSec = Mathf.Max(0f, sec);
            if (was) Play(clip, _startSec, _speed, _beatProvider);
        }

        public void Dispose()
        {
            if (_go == null) return;
            Stop();
            Object.DestroyImmediate(_go);
            _go = null;
        }
    }
}
