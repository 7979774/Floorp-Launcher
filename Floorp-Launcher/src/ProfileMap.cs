using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace FloorpLauncher
{
    /// <summary>
    /// Tiny hand-rolled reader/writer for data\profiles.json: a flat
    /// {"profileName": "saltedFolderName", ...} map. This plays the same
    /// role as Firefox's own profiles.ini - an explicit, unambiguous
    /// name-&gt;folder mapping, so profile resolution never has to guess.
    /// </summary>
    internal sealed class ProfileMap
    {
        private readonly Dictionary<string, string> _entries =
            new Dictionary<string, string>();

        public bool TryGetValue(string name, out string folder)
        {
            return _entries.TryGetValue(name, out folder);
        }

        public IEnumerable<string> Keys
        {
            get { return _entries.Keys; }
        }

        public string this[string name]
        {
            get { return _entries[name]; }
            set { _entries[name] = value; }
        }

        public static ProfileMap Load(string path)
        {
            var map = new ProfileMap();
            if (!File.Exists(path)) return map;

            string text = File.ReadAllText(path);
            foreach (Match m in Regex.Matches(text, "\"([^\"]+)\"\\s*:\\s*\"([^\"]+)\""))
            {
                map._entries[m.Groups[1].Value] = m.Groups[2].Value;
            }
            return map;
        }

        public void Save(string path)
        {
            var sb = new StringBuilder();
            sb.Append("{\r\n");
            int i = 0;
            foreach (var kv in _entries)
            {
                sb.Append("  \"").Append(kv.Key).Append("\": \"").Append(kv.Value).Append("\"");
                i++;
                sb.Append(i < _entries.Count ? ",\r\n" : "\r\n");
            }
            sb.Append("}\r\n");
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }
    }
}
