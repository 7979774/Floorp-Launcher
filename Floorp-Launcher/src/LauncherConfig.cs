using System.IO;
using System.Text.RegularExpressions;

namespace FloorpLauncher
{
    /// <summary>
    /// Tiny hand-rolled reader for floorp-launcher.json so the launcher has
    /// no external dependencies. Missing file or missing keys fall back to
    /// sensible defaults.
    /// </summary>
    internal sealed class LauncherConfig
    {
        public string Profile = "default";
        public bool MultipleInstances = false;
        public bool Cleanup = false;
        public bool CheckForUpdates = true;

        public static LauncherConfig Load(string path)
        {
            var cfg = new LauncherConfig();
            if (!File.Exists(path)) return cfg;

            string text = File.ReadAllText(path);

            Match m = Regex.Match(text, "\"profile\"\\s*:\\s*\"([^\"]*)\"");
            if (m.Success && m.Groups[1].Value.Length > 0) cfg.Profile = m.Groups[1].Value;

            cfg.MultipleInstances = ReadBool(text, "multipleInstances", cfg.MultipleInstances);
            cfg.Cleanup = ReadBool(text, "cleanup", cfg.Cleanup);
            cfg.CheckForUpdates = ReadBool(text, "checkForUpdates", cfg.CheckForUpdates);

            return cfg;
        }

        private static bool ReadBool(string text, string key, bool fallback)
        {
            Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*(true|false)");
            if (!m.Success) return fallback;
            return m.Groups[1].Value == "true";
        }
    }
}
