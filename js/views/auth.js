// Pantallas de configuración inicial y de login.

import { el, mount, toast, withBusy } from '../dom.js';
import { getConfig, saveConfig, looksLikeSecretKey, looksLikePublishableKey } from '../config.js';
import { resetClient, signIn, signUp, resetPassword, authErrorMessage } from '../supabase.js';

/** Primera pantalla si no hay URL/anon key configuradas. */
export function renderSetup(root, onDone) {
  const form = el('form', { class: 'card auth' },
    el('h1', {}, 'LootHound'),
    el('p', { class: 'muted' },
      'Conecta tu propio proyecto de Supabase. Estos datos se guardan sólo en ' +
      'este navegador (localStorage).'),

    el('label', {}, 'URL del proyecto',
      el('input', {
        name: 'url', type: 'url', required: true,
        placeholder: 'https://xxxxxxxx.supabase.co', autocomplete: 'off',
      })),

    el('label', {}, 'Llave publicable',
      el('input', {
        name: 'anonKey', type: 'text', required: true,
        placeholder: 'sb_publishable_...', autocomplete: 'off',
      })),

    el('p', { class: 'note' },
      'En Supabase: ', el('strong', {}, 'Project Settings → API Keys'), '. Usa la ',
      el('strong', {}, 'publishable'), ' (o la ', el('strong', {}, 'anon'),
      ' si tu proyecto es de antes). Nunca la ', el('strong', {}, 'secret'),
      ' ni la ', el('strong', {}, 'service_role'), ': ésas se saltan RLS.'),

    el('button', { class: 'btn btn--primary', type: 'submit' }, 'Conectar'),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = form.url.value.trim();
    const anonKey = form.anonKey.value.trim();

    if (!/^https:\/\/[^/]+\.supabase\.(co|in)$/i.test(url.replace(/\/+$/, ''))) {
      toast('Esa URL no parece de Supabase. Debe verse como https://xxxx.supabase.co', 'error');
      return;
    }
    if (looksLikeSecretKey(anonKey)) {
      toast('Esa llave es secreta y se salta RLS. Usa la publishable / anon.', 'error', 9000);
      return;
    }
    if (!looksLikePublishableKey(anonKey)) {
      toast('Esa llave no parece de Supabase. Debe empezar con "sb_publishable_" o "eyJ".',
        'error', 8000);
      return;
    }
    saveConfig({ url, anonKey });
    resetClient();
    onDone();
  });

  mount(root, el('div', { class: 'auth-wrap' }, form));
}

/** Login / registro. */
export function renderAuth(root) {
  let mode = 'signin';

  const render = () => {
    const isSignIn = mode === 'signin';

    const form = el('form', { class: 'card auth' },
      el('h1', {}, 'LootHound'),
      el('p', { class: 'muted' },
        isSignIn ? 'Entra a tu cuenta.' : 'Crea tu cuenta.'),

      el('label', {}, 'Correo',
        el('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),

      el('label', {}, 'Contraseña',
        el('input', {
          name: 'password', type: 'password', required: true, minlength: '6',
          autocomplete: isSignIn ? 'current-password' : 'new-password',
        })),

      el('button', { class: 'btn btn--primary', type: 'submit' },
        isSignIn ? 'Entrar' : 'Registrarme'),

      el('div', { class: 'auth__links' },
        el('button', {
          type: 'button', class: 'linkish',
          onclick: () => { mode = isSignIn ? 'signup' : 'signin'; render(); },
        }, isSignIn ? 'No tengo cuenta' : 'Ya tengo cuenta'),

        isSignIn && el('button', {
          type: 'button', class: 'linkish',
          onclick: async () => {
            const email = form.email.value.trim();
            if (!email) return toast('Escribe tu correo primero.', 'error');
            try {
              await resetPassword(email);
              toast('Te mandamos un correo para restablecer la contraseña.', 'ok');
            } catch (err) { toast(authErrorMessage(err), 'error'); }
          },
        }, 'Olvidé mi contraseña'),
      ),

      el('button', {
        type: 'button', class: 'linkish linkish--quiet',
        onclick: () => {
          localStorage.removeItem('loothound.supabase');
          location.reload();
        },
      }, `Cambiar de proyecto (${new URL(getConfig().url).hostname})`),
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const email = form.email.value.trim();
      const password = form.password.value;

      await withBusy(btn, async () => {
        try {
          if (isSignIn) {
            await signIn(email, password);
            // el cambio de sesión lo detecta app.js
          } else {
            const data = await signUp(email, password);
            if (data.session) return; // confirmación de correo apagada: ya entró
            toast('Revisa tu correo para confirmar la cuenta.', 'ok', 8000);
            mode = 'signin';
            render();
          }
        } catch (err) {
          toast(authErrorMessage(err), 'error', 6000);
        }
      });
    });

    mount(root, el('div', { class: 'auth-wrap' }, form));
  };

  render();
}
