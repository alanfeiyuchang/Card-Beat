using System.IO;

namespace CardBeat.EditorTools
{
    /// <summary>Minimal 16-bit PCM mono WAV writer for baking generated audio to an asset.</summary>
    public static class WavWriter
    {
        public static void Write(string path, float[] samples, int sampleRate)
        {
            using var fs = new FileStream(path, FileMode.Create);
            using var w = new BinaryWriter(fs);
            int dataLen = samples.Length * 2;
            w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
            w.Write(36 + dataLen);
            w.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
            w.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
            w.Write(16);
            w.Write((short)1);            // PCM
            w.Write((short)1);            // mono
            w.Write(sampleRate);
            w.Write(sampleRate * 2);      // byte rate
            w.Write((short)2);            // block align
            w.Write((short)16);           // bits
            w.Write(System.Text.Encoding.ASCII.GetBytes("data"));
            w.Write(dataLen);
            foreach (var s in samples)
            {
                float c = s < -1f ? -1f : (s > 1f ? 1f : s);
                w.Write((short)(c * short.MaxValue));
            }
        }
    }
}
