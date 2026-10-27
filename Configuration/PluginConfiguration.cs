using MediaBrowser.Model.Plugins;
using System.Globalization;

namespace Jellyfin.Plugin.Petrify.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public string ServerPort { get; set; } = "8787";
    public string DiscoveryPort { get; set; } = "8788";
    public string LocalJellyfin { get; set; } = "http://127.0.0.1:8096,http://localhost:8096";
    public int PartyLeadMs { get; set; } = 1000;
    public int PartyTrackLeadMs { get; set; } = 2200;

    public void Validate()
    {
        ValidatePort(ServerPort, "Relay port");
        ValidatePort(DiscoveryPort, "Discovery port");
        if (PartyLeadMs < 300 || PartyLeadMs > 30000)
            throw new ArgumentException("Party command lead must be between 300 and 30000 ms.");
        if (PartyTrackLeadMs < 800 || PartyTrackLeadMs > 30000)
            throw new ArgumentException("Party track lead must be between 800 and 30000 ms.");

        if (string.IsNullOrWhiteSpace(LocalJellyfin))
            throw new ArgumentException("Enter at least one local Jellyfin HTTP(S) base URL.");
        foreach (var address in LocalJellyfin.Split(','))
        {
            if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                || string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo)
                || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
                throw new ArgumentException("Local Jellyfin addresses must be comma-separated HTTP(S) base URLs without credentials, queries or fragments.");
        }
    }

    private static void ValidatePort(string value, string name)
    {
        if (!int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var port)
            || port < 1 || port > 65535)
            throw new ArgumentException($"{name} must be a whole number between 1 and 65535.");
    }
}
