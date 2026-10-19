using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Petrify.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public string ServerPort { get; set; } = "8787";
}
