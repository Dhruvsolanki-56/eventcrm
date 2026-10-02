import { expect, test } from '@playwright/test';

test.skip(process.env.GATHER_TEST_LOCAL_TRANSCRIPTION !== '1', 'Opt-in model download and device test.');

test('a synthetic voice note can be transcribed locally without saving it automatically', async ({ page }) => {
  test.setTimeout(180_000);
  const audioUploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /huggingface\.co|hf\.co|xethub\.hf\.co/.test(request.url())) audioUploads.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Maya Chen/ }).click();
  await page.getByRole('link', { name: 'People' }).click();
  await page.getByRole('link', { name: /Tessa Morgan/ }).click();
  const note = page.locator('.saved-voice').first();
  const before = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as { voiceNotes: Array<{ id: string; transcript: string }> };
  await note.getByRole('button', { name: 'Transcribe on this device' }).click();
  await expect(note.getByLabel('Suggested transcript · check before saving')).toBeVisible({ timeout: 150_000 });
  expect((await note.getByLabel('Suggested transcript · check before saving').inputValue()).trim().length).toBeGreaterThan(0);
  expect(audioUploads).toEqual([]);
  const after = await (await page.request.get('/api/contacts/demo-ns-contact-1')).json() as typeof before;
  expect(after.voiceNotes).toEqual(before.voiceNotes);
});
