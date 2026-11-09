// Sample ASP.NET Core API for trying Yept against the team's stack over https://localhost (dev certificate).
// Login issues an opaque bearer token held in memory; no auth packages needed.
// Run: dotnet run --urls https://localhost:7443
using System.Collections.Concurrent;
using System.Security.Cryptography;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseHttpsRedirection();

// Demo credentials for local testing only. Configure via appsettings or environment variables.
var demoUser = app.Configuration["Demo:Username"] ?? "demo";
var demoPassword = app.Configuration["Demo:Password"] ?? "demo-password";
var tokens = new ConcurrentDictionary<string, string>();

app.MapPost("/auth/login", (LoginRequest login) =>
{
    if (login.Username != demoUser || login.Password != demoPassword)
        return Results.Json(new { error = "invalid_credentials" }, statusCode: StatusCodes.Status401Unauthorized);
    var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    tokens[token] = login.Username;
    return Results.Ok(new { access_token = token, token_type = "Bearer", expires_in = 3600 });
});

app.MapGet("/api/me", (HttpRequest request) =>
{
    var header = request.Headers.Authorization.ToString();
    var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : null;
    return token is not null && tokens.TryGetValue(token, out var user)
        ? Results.Ok(new { username = user, issuedTokens = tokens.Count })
        : Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
});

var summaries = new[] { "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching" };

app.MapGet("/weatherforecast", () =>
    Enumerable.Range(1, 5).Select(index => new WeatherForecast(
        DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
        Random.Shared.Next(-20, 55),
        summaries[Random.Shared.Next(summaries.Length)])).ToArray());

app.Run();

record LoginRequest(string Username, string Password);

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
