(() => {
  const CITY_KEY = 'codex-pet.weather-city';
  const UNAVAILABLE = '暂时无法查询天气，请稍后再试。';

  class PetWeatherCard {
    constructor({ query, onChange }) {
      this.query = query;
      this.onChange = onChange;
      this.city = '';
      this.revision = 0;
      this.loading = false;

      this.element = document.createElement('div');
      this.element.className = 'pet-weather-card';
      this.element.hidden = true;
      this.element.setAttribute('role', 'group');
      this.element.setAttribute('aria-label', '天气');

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'pet-weather-close';
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭天气');
      close.addEventListener('click', () => this.close());

      this.form = document.createElement('form');
      this.form.className = 'pet-weather-form';
      this.input = document.createElement('input');
      this.input.type = 'text';
      this.input.maxLength = 80;
      this.input.placeholder = '输入城市';
      this.input.autocomplete = 'off';
      this.input.setAttribute('aria-label', '城市');
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = '查询';
      this.form.append(this.input, submit);
      this.form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!this.form.hidden) this.load(this.input.value.trim(), true);
      });

      this.message = document.createElement('div');
      this.message.className = 'pet-weather-message';
      this.message.setAttribute('role', 'status');
      this.message.addEventListener('click', () => {
        if (this.form.hidden) this.close();
      });

      this.changeCity = document.createElement('button');
      this.changeCity.type = 'button';
      this.changeCity.className = 'pet-weather-change';
      this.changeCity.textContent = '换城市';
      this.changeCity.addEventListener('click', () => this.edit());
      this.element.append(close, this.form, this.message, this.changeCity);

      this.onKeyDown = (event) => {
        if (event.key !== 'Escape' || event.isComposing || this.element.hidden) return;
        event.preventDefault();
        this.close();
      };
      document.addEventListener('keydown', this.onKeyDown);
    }

    savedCity() {
      try {
        return window.localStorage.getItem(CITY_KEY) || this.city;
      } catch {
        return this.city;
      }
    }

    open() {
      if (this.loading) return;
      const city = this.savedCity();
      if (!city) return this.edit();
      return this.load(city, false);
    }

    edit() {
      this.revision++;
      this.loading = false;
      this.input.value = this.savedCity();
      this.render({ editing: true });
      this.input.focus();
      this.input.select();
    }

    async load(city, editing) {
      if (this.loading) return;
      if (!city) {
        this.render({ editing: true, message: '请输入城市名称。' });
        this.input.focus();
        return;
      }

      const revision = ++this.revision;
      this.loading = true;
      this.render({ message: '正在查询天气…' });
      let result;
      try {
        result = await this.query(city);
      } catch {
        result = null;
      }
      if (revision !== this.revision) return;
      this.loading = false;

      const message = typeof result?.message === 'string' && result.message ? result.message : UNAVAILABLE;
      if (result?.ok === true) {
        this.city = city;
        try {
          window.localStorage.setItem(CITY_KEY, city);
        } catch {
          // Weather remains available in this window if the profile cannot write storage.
        }
      }
      const retryWithInput = editing && result?.ok !== true;
      this.render({ editing: retryWithInput, message, canChange: !retryWithInput });
      if (retryWithInput) this.input.focus();
    }

    render({ editing = false, message = '', canChange = false }) {
      this.form.hidden = !editing;
      this.message.textContent = message;
      this.changeCity.hidden = !canChange;
      this.element.hidden = false;
      this.onChange();
    }

    close() {
      if (this.element.hidden) return;
      this.revision++;
      this.loading = false;
      this.element.hidden = true;
      this.onChange();
    }

    dispose() {
      this.revision++;
      document.removeEventListener('keydown', this.onKeyDown);
      this.element.remove();
    }
  }

  window.PetWeatherCard = PetWeatherCard;
})();
