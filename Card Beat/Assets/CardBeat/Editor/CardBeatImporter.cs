using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace CardBeat.EditorTools
{
    /// <summary>
    /// Imports a Card Beat export (&lt;clip&gt;_cardbeat.zip or an extracted folder) into the
    /// project: copies frames + per-object masks under Assets/CardBeatClips/&lt;name&gt;/,
    /// parses cardbeat.json v2 and creates a CardBeatClipAsset wired to the sprites.
    /// </summary>
    public static class CardBeatImporter
    {
        const string RootFolder = "Assets/CardBeatClips";

        [MenuItem("Card Beat/Import Package (.zip)…")]
        public static void ImportZipMenu()
        {
            string zip = EditorUtility.OpenFilePanel("Card Beat package", "", "zip");
            if (string.IsNullOrEmpty(zip)) return;
            ImportZip(zip);
        }

        [MenuItem("Card Beat/Import Extracted Folder…")]
        public static void ImportFolderMenu()
        {
            string folder = EditorUtility.OpenFolderPanel("Folder containing cardbeat.json", "", "");
            if (string.IsNullOrEmpty(folder)) return;
            if (!File.Exists(Path.Combine(folder, "cardbeat.json")))
            {
                EditorUtility.DisplayDialog("Card Beat", "No cardbeat.json found in that folder.", "OK");
                return;
            }
            Import(folder, new DirectoryInfo(folder).Name);
        }

        public static CardBeatClipAsset ImportZip(string zipPath)
        {
            string temp = Path.Combine(Path.GetTempPath(), "cardbeat_import_" + Guid.NewGuid().ToString("N"));
            try
            {
                ZipFile.ExtractToDirectory(zipPath, temp);
                string name = Path.GetFileNameWithoutExtension(zipPath);
                if (name.EndsWith("_cardbeat")) name = name.Substring(0, name.Length - "_cardbeat".Length);
                return Import(temp, name);
            }
            finally
            {
                if (Directory.Exists(temp)) Directory.Delete(temp, true);
            }
        }

        public static CardBeatClipAsset Import(string srcFolder, string clipName)
        {
            string json = File.ReadAllText(Path.Combine(srcFolder, "cardbeat.json"));
            var meta = JsonUtility.FromJson<MetaDto>(json);

            clipName = SanitizeName(clipName);
            string destRel = $"{RootFolder}/{clipName}";
            EnsureFolder(RootFolder);
            if (AssetDatabase.IsValidFolder(destRel))
                AssetDatabase.DeleteAsset(destRel);
            AssetDatabase.CreateFolder(RootFolder, clipName);

            string destAbs = Path.GetFullPath(destRel);

            // frames
            var framePngs = SortedPngs(Path.Combine(srcFolder, "frames"));
            if (framePngs.Count == 0)
                throw new InvalidOperationException("Package has no frames/ PNGs.");
            Directory.CreateDirectory(Path.Combine(destAbs, "frames"));
            CopyAll(framePngs, Path.Combine(destAbs, "frames"), "importing frames");

            // per-object masks
            var maskDirs = new List<string>();
            string masksRoot = Path.Combine(srcFolder, "masks");
            if (Directory.Exists(masksRoot))
                foreach (var dir in Directory.GetDirectories(masksRoot))
                {
                    string slug = Path.GetFileName(dir);
                    var pngs = SortedPngs(dir);
                    if (pngs.Count == 0) continue;
                    Directory.CreateDirectory(Path.Combine(destAbs, "masks", slug));
                    CopyAll(pngs, Path.Combine(destAbs, "masks", slug), $"importing mask '{slug}'");
                    maskDirs.Add(slug);
                }

            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

            var asset = ScriptableObject.CreateInstance<CardBeatClipAsset>();
            asset.sourceName = string.IsNullOrEmpty(meta.source) ? clipName : meta.source;
            asset.fps = meta.output != null && meta.output.fps > 0 ? meta.output.fps : 30f;
            asset.width = meta.output?.width ?? 0;
            asset.height = meta.output?.height ?? 0;
            asset.beatsSec = meta.beatsSec ?? Array.Empty<float>();
            asset.beatsAccent = meta.beatsAccent ?? Array.Empty<bool>();
            asset.secondsPerBeat = meta.beat != null && meta.beat.secondsPerBeat > 0 ? meta.beat.secondsPerBeat : 0.5f;
            asset.bpm = meta.beat != null && meta.beat.bpm > 0 ? meta.beat.bpm : 60f / asset.secondsPerBeat;
            asset.frames = LoadSprites($"{destRel}/frames");

            var layerInfos = new List<ClipLayerInfo>();
            foreach (var slug in maskDirs)
            {
                var dto = meta.layers?.FirstOrDefault(l => l.maskDir == $"masks/{slug}" || l.slug == slug || l.name == slug);
                var info = new ClipLayerInfo
                {
                    name = dto?.name ?? slug,
                    maskDir = $"masks/{slug}",
                    maskFrames = LoadSprites($"{destRel}/masks/{slug}"),
                };
                if (dto?.style != null && ColorUtility.TryParseHtmlString(dto.style.tint, out var tint))
                    info.tint = tint;
                layerInfos.Add(info);
            }
            asset.layers = layerInfos.ToArray();

            string assetPath = $"{destRel}/{clipName}.asset";
            AssetDatabase.CreateAsset(asset, assetPath);
            AssetDatabase.SaveAssets();
            EditorUtility.ClearProgressBar();

            Selection.activeObject = asset;
            EditorGUIUtility.PingObject(asset);
            Debug.Log($"[Card Beat] Imported '{clipName}': {asset.frames.Length} frames @ {asset.fps} fps, " +
                      $"{asset.beatsSec.Length} beats ({asset.AnchorTimes().Count} anchors), {layerInfos.Count} mask layer(s).");
            return asset;
        }

        static List<string> SortedPngs(string dir) =>
            Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*.png").OrderBy(p => p, StringComparer.Ordinal).ToList()
                : new List<string>();

        static void CopyAll(List<string> files, string destDir, string label)
        {
            for (int i = 0; i < files.Count; i++)
            {
                if (i % 25 == 0)
                    EditorUtility.DisplayProgressBar("Card Beat", label, i / (float)files.Count);
                File.Copy(files[i], Path.Combine(destDir, Path.GetFileName(files[i])), true);
            }
        }

        static Sprite[] LoadSprites(string folderRel)
        {
            return AssetDatabase.FindAssets("t:Sprite", new[] { folderRel })
                .Select(AssetDatabase.GUIDToAssetPath)
                .OrderBy(p => p, StringComparer.Ordinal)
                .Select(AssetDatabase.LoadAssetAtPath<Sprite>)
                .Where(s => s != null)
                .ToArray();
        }

        static void EnsureFolder(string rel)
        {
            if (!AssetDatabase.IsValidFolder(rel))
                AssetDatabase.CreateFolder(Path.GetDirectoryName(rel).Replace('\\', '/'), Path.GetFileName(rel));
        }

        static string SanitizeName(string s)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s.Replace('.', '_');
        }

#pragma warning disable 0649
        [Serializable] class MetaDto
        {
            public string source;
            public int version;
            public OutputDto output;
            public float durationOutSec;
            public BeatDto beat;
            public float[] beatsSec;
            public bool[] beatsAccent;
            public LayerDto[] layers;
        }
        [Serializable] class OutputDto { public int width; public int height; public float fps; public int frameCount; }
        [Serializable] class BeatDto { public float secondsPerBeat; public float bpm; }
        [Serializable] class LayerDto { public string name; public string slug; public string maskDir; public StyleDto style; }
        [Serializable] class StyleDto { public string tint; }
#pragma warning restore 0649
    }

    /// <summary>Applies sprite import settings to every PNG under Assets/CardBeatClips/.</summary>
    class CardBeatTexturePostprocessor : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            if (!assetPath.Replace('\\', '/').StartsWith("Assets/CardBeatClips/")) return;
            var ti = (TextureImporter)assetImporter;
            ti.textureType = TextureImporterType.Sprite;
            ti.spriteImportMode = SpriteImportMode.Single;
            ti.alphaIsTransparency = true;
            ti.mipmapEnabled = false;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.wrapMode = TextureWrapMode.Clamp;
            ti.filterMode = FilterMode.Bilinear;
            ti.maxTextureSize = 2048;
        }
    }
}
