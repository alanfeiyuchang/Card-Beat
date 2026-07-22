using UnityEngine;

namespace CardBeat
{
    /// <summary>
    /// The dspTime song clock. Everything (clip frames, judgement, metronome, note lane)
    /// reads SongTime from here so audio, visuals and input judgement share one timeline —
    /// the same AudioSettings.dspTime contract cardbeat.json is designed for.
    /// </summary>
    [RequireComponent(typeof(AudioSource))]
    public class Conductor : MonoBehaviour
    {
        public AudioSource Source { get; private set; }

        /// <summary>Playback speed (practice mode). Applied as pitch, compensated in SongTime.</summary>
        public float speed = 1f;

        double _dspSongStart;
        bool _running;
        float _pausedAt;
        bool _paused;

        public bool IsRunning => _running && !_paused;

        /// <summary>Current song time in seconds. Negative during the lead-in.</summary>
        public float SongTime
        {
            get
            {
                if (!_running) return 0f;
                if (_paused) return _pausedAt;
                return (float)((AudioSettings.dspTime - _dspSongStart) * speed);
            }
        }

        void Awake()
        {
            Source = GetComponent<AudioSource>();
            Source.playOnAwake = false;
        }

        public void StartSong(AudioClip song, float leadInSec, float atSpeed = 1f)
        {
            speed = Mathf.Clamp(atSpeed, 0.25f, 2f);
            double now = AudioSettings.dspTime;
            _dspSongStart = now + leadInSec / speed;
            if (song != null)
            {
                Source.clip = song;
                Source.pitch = speed;
                Source.PlayScheduled(_dspSongStart);
            }
            _running = true;
            _paused = false;
        }

        public void Stop()
        {
            _running = false;
            _paused = false;
            if (Source != null) Source.Stop();
        }

        public void Pause()
        {
            if (!_running || _paused) return;
            _pausedAt = SongTime;
            _paused = true;
            Source.Pause();
        }

        public void Resume()
        {
            if (!_running || !_paused) return;
            _dspSongStart = AudioSettings.dspTime - _pausedAt / speed;
            _paused = false;
            Source.UnPause();
        }

        public bool SongEnded(float songLength) => _running && SongTime >= songLength + 0.5f;
    }
}
