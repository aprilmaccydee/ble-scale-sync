import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { input, password } from '@inquirer/prompts';
import { stringify } from 'yaml';
import { loginZepp, ZeppAuthError, type ZeppSession } from './zepp-auth.js';
import { parseZeppConfig } from './zepp-config.js';
import { ZeppExporter } from './zepp.js';

/** Writes an exporter-list fragment, never the account password. */
export function writeZeppExporterYaml(output: string, session: ZeppSession): void {
  const config = parseZeppConfig({ ...session });
  const entry = {
    type: 'zepp',
    app_token: config.appToken,
    user_id: config.userId,
    member_id: '-1',
    base_url: config.baseUrl,
    time_zone: config.timeZone,
    upload_mode: 'full',
  };
  const content =
    '# Merge this entry into the appropriate users[].exporters list in config.yaml.\n' +
    '# Private session credential; do not commit this file.\n' +
    (session.expires_at
      ? `# Session expires at approximately ${session.expires_at}. Run setup-zepp again to renew.\n`
      : '') +
    stringify([entry]);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, output);
    chmodSync(output, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Already renamed, or creation failed. */
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      credentials: { type: 'string' },
      output: { type: 'string', default: '.zepp-exporter.local.yaml' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npm run setup-zepp -- [--credentials private.json] [--output .zepp-exporter.local.yaml]',
    );
    console.log('Without --credentials, prompts for email, password and country.');
    console.log('Writes a private YAML exporter entry; no health records are uploaded.');
    return;
  }
  let credentials: unknown;
  if (values.credentials) {
    try {
      credentials = JSON.parse(readFileSync(values.credentials, 'utf8'));
    } catch {
      throw new ZeppAuthError('Cannot read credentials JSON (username, password, country_code)');
    }
  } else {
    credentials = {
      username: await input({ message: 'Zepp email:' }),
      password: await password({ message: 'Zepp password:' }),
      country_code: await input({
        message: 'Two-letter country code:',
        default: new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).region ?? 'US',
      }),
    };
  }
  console.log('Signing into the Zepp web application...');
  const session = await loginZepp(credentials);
  const check = await new ZeppExporter(parseZeppConfig({ ...session })).healthcheck();
  if (!check.success) throw new ZeppAuthError(check.error ?? 'Zepp connection check failed');
  writeZeppExporterYaml(resolve(values.output), session);
  console.log(`Session verified. Private exporter entry saved to ${values.output}.`);
  console.log('Merge the entry into the intended user’s exporters list in config.yaml.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof ZeppAuthError
        ? error.message
        : 'Zepp setup failed; check the input and output file paths.',
    );
    process.exitCode = 1;
  });
}
