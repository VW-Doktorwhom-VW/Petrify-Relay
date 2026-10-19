using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using Jellyfin.Plugin.Petrify.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Petrify;

public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public override string Name => "Petrify";
    public override Guid Id => Guid.Parse("a8c9038d-19df-4122-a9bd-831e3d09e8f4");
    public override string Description => "Self-contained network relay service for Petrify clients.";

    public static Plugin? Instance { get; private set; }
    private static Process? _nodeProcess;

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        StartNodeRelay();
    }

    private void StartNodeRelay()
    {
        try
        {
            var dataDir = DataFolderPath;
            Directory.CreateDirectory(dataDir);

            string nodePath = Path.Combine(dataDir, "node");
            string scriptPath = Path.Combine(dataDir, "server.mjs");

            ExtractEmbeddedResource("Jellyfin.Plugin.Petrify.Resources.node", nodePath);
            ExtractEmbeddedResource("Jellyfin.Plugin.Petrify.Resources.server.mjs", scriptPath);

            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                File.SetUnixFileMode(nodePath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }

            if (_nodeProcess != null && !_nodeProcess.HasExited)
            {
                try { _nodeProcess.Kill(true); } catch { }
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = scriptPath,
                WorkingDirectory = dataDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            _nodeProcess = new Process { StartInfo = startInfo };
            _nodeProcess.Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Petrify Plugin Error] {ex.Message}");
        }
    }

    private void ExtractEmbeddedResource(string resourceName, string outputPath)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null) return;

        using var fileStream = File.Create(outputPath);
        stream.CopyTo(fileStream);
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "Petrify",
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            }
        };
    }
}
