const WEATHER_URL = 'https://uapis.cn/api/v1/misc/weather';
const FETCH_TIMEOUT_MS = 8000;

async function fetchWeather(city, { request = globalThis.fetch } = {}) {
  const query = typeof city === 'string' ? city.trim() : '';
  if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/u.test(query)) {
    // UApiPro can locate by IP when the city is omitted. Always require an explicit city.
    return { ok: false, message: '请输入有效的城市名称。' };
  }

  const url = new URL(WEATHER_URL);
  url.searchParams.set('city', query);
  url.searchParams.set('lang', 'zh');
  const unavailable = { ok: false, message: '暂时无法查询天气，请稍后再试。' };

  try {
    const response = await request(url.href, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 429) {
      const limit = await response.json().catch(() => null);
      if (limit?.error === 'VISITOR_MONTHLY_QUOTA_EXHAUSTED') {
        return { ok: false, message: '天气服务本月的访客额度已用完。' };
      }
      return { ok: false, message: '天气查询太频繁，请稍后再试。' };
    }
    if (response.status === 404) {
      return { ok: false, message: '未找到该城市的天气，请检查名称。' };
    }
    if (!response.ok) return unavailable;

    const observation = await response.json();
    const place = typeof observation?.city === 'string' ? observation.city.trim() : '';
    const description = typeof observation?.weather === 'string' ? observation.weather.trim() : '';
    const temperature = observation?.temperature;
    if (place && description && Number.isFinite(temperature)) {
      return { ok: true, message: `${place} · ${description} · ${temperature} ℃` };
    }
  } catch {
    // Keep city queries, network details, and provider error bodies out of app logs.
  }

  return unavailable;
}

module.exports = { fetchWeather };
