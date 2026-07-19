import { expect, test, type Page } from "@playwright/test";

// Attachments UI (#109): upload → listed → bad type rejected → delete →
// re-upload → Run Now. Like the smoke, this runs in CI without
// LibreChat, where the triggered run eventually FAILs — so the
// searchable-PDF artifact assertion only fires when the run actually
// reaches SUCCESS (a live stack with the full AI path up).
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@nexus-scheduler.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123";

const runTag = `e2e-att-${Date.now().toString(36)}`;

// 640x400 RGB PNG with two lines of text — big enough for img2pdf's
// minimum page size at 300dpi (a 1x1 pixel renders as a 0.24pt page,
// which it rightly refuses) and alpha-free, matching a real scan.
const TEST_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAoAAAAGQCAIAAACxkUZyAAAQqElEQVR4nO3beYhVdf/A8WNO2USi5mj9U4ZRKtlomsuYs2iOWpao" +
    "lQSVWlMRUVbYQhvVP5m5tFGUxrRQIWXGkJVjTWYoWkGUYAZpmy04ZWSalc7MeXi4/C7D3EWf6uen5+n1+uvcez7fc889/vH23Du3" +
    "U5qmCQBwcB1ykF8PABBgAIjhDhgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANA" +
    "AAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAAB" +
    "BBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQ" +
    "YAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAD4hwW4tLR0zJgx2Yfdu3fPbBxxxBE1/2fRokWNjY3Tpk3L7Nq0adPw" +
    "4cNbW1uzw+0XfvDBB+PHjx8zZkxtbe22bduyAx0OmCRJfX19ZWXl4MGDV61aVWgm64knnujSpcv27duTJHn55ZczMyUlJZmNm266" +
    "qcMzy5Yt67AqSZIlS5YMGTKkurp60qRJ2XNr/y7aPywtLZ0+fXr2+Ysuuqi0tLTQeea9jLnnmTmrvM/nHrPDlSx0NAD+uDROt27d" +
    "Ro8evXr16uzDDhtZkyZNWrNmTZqmtbW169ev7zCT3R40aNC2bdvSNF22bNn06dNzBzKam5urqqpaW1s3b97cv3//Qi+aNXny5Btu" +
    "uKG+vr7Dyee+nUKrVq1aNWbMmD179qRp+tprr40dOzbvkvZXoLy8vKWlJU3Ttra2kSNHFrk4hS5j8feV9wJmHeCVBOAPC/4I+u67" +
    "777zzjv3O7Zw4cKbb775pZde6tOnz8iRIwuNNTc3//bbb0mSTJ48+eqrry40tmPHjquvvvqQQw459thjd+zYUfyl9+zZ88svv1x2" +
    "2WUrVqzY73kWWrVgwYJ77rkncxd75plnnnDCCfv27St+hCFDhrz//vtJknz44Yfl5eV/yWU8cAd4JQH4w4IDPHbs2CRJVq9eXXys" +
    "X79+I0aMuP766++9994iY/fcc09lZWVdXd3atWsrKysLjfXv3//8889PkmTZsmXnnHNO8ZdubGycOHFiv379vvjii7179+7vDeVf" +
    "tWnTplNPPTW7d/HixYceemjxI0yYMKGxsTFzqAkTJvwll/HAHeCVBOC/+I+wcu/e9u7dm/1Kcv369Zknf/7555KSkt27dxc51KxZ" +
    "sz7++OPRo0dfd911d911V/EDbt26df78+dmi551JkqShoeHZZ58dOXLkt99+u2bNmgN8Ux1Wtba25h1r/6I1NTXtAz9+/Pg333wz" +
    "SZK33npr3Lhxxd/Ln7wJzj1moSsJwF8mjZP9QrGmpqapqanI15xr166dNm3aqlWrJk+enHmmR48ema9I9+3b17Nnz8w3u+vWrcvs" +
    "bW5uPvroo3NfKGvXrl1Dhw7dsGFDkZk0TVtaWioqKjLbK1eunD17dpH57DO5q6qqqrKv1dbWNmPGjLwH6XAFqqqqvvrqq9ra2uJf" +
    "kBe6jH/4O+D/6EoC8MfE3wHv9+6tpaXl+uuvnz9/fm1tbUlJSUNDQ5Ikw4YNe+ONNzKf0A4bNixJkk6dOk2fPj3zB8Y7duw47rjj" +
    "Ch0wTdOZM2fOmTNnxIgRxU9s3bp1gwYNymxXVlZm/2T6P1111VVX3X777b///nuSJEuXLs1s7NfEiRNvu+229re/B+eb4AO/kgD8" +
    "YSXJ30BVVdVhhx2WzVLmE9HMdkVFRa9evcaNG9e3b98kSe6///4JEyaMGzfu4Ycfvvzyy+fOnZv5hU+SJGVlZYsXLz7//PNLS0s7" +
    "d+5cX1+fPX6HA5500kmNjY07dux4/PHHjzzyyMzfSXWYyRy5oaEh8/Vq5vc/vXv33rx584ABA4q/ndxV5eXl1dXVQ4cO7dWrV+/e" +
    "vR955JEDuSyTJk267bbbNm7c2P7JvOeZ9zIeuNxjFrqSAPxVOqVp+pcdDAA4MH+Lj6AB4J9GgAEggAADQAABBoAAAgwAAQQYAAII" +
    "MAAEEGAACCDAABBAgAEggAADQAABBoAAAgwAAQQYAAIIMAAEEGAACCDAABBAgAEggAADQAABBoAAAgwAAQQYAAIIMAAEEGAACCDA" +
    "ABBAgAEggAADQAABBoAAAgwAAQQYAAIIMAAEEGAACCDAABBAgAEggAADQAABBoAAAgwAAQQYAAIIMAAEEGAACCDAABBAgAEggAAD" +
    "QAABBoAAAgwAAQQYAAIIMAAEEGAACCDAABBAgAEgwN89wJ988sm8efN27twZfSIA8L8S4COOOKKmpqa6unrIkCFr1qzJOzN16tTS" +
    "0tKSkpKo08tYtGhRkiT19fWVlZWDBw9etWpVoZmsDsM7d+6cMmXK6NGjp0yZkv3/RIeZtra22bNnV1RUVFVVffbZZ+2Plrv8ggsu" +
    "yLzuqFGjysrKMmM//fTTrFmzunXrlnnY1NQ0atSoMWPGVFZWrl+//qBcNgAOTBqnW7dumY2NGzeecsopeWe6d++eRp9eRnNzc1VV" +
    "VWtr6+bNm/v37593psjwjTfeuHDhwjRNFyxYcPPNN+edeeSRR2699dY0TZcvXz516tT2B8xdnrVkyZI77rgjsz169OiHHnooe1Z9" +
    "+vT57LPP0jTdsmXLgAED/tLLA8Cf8rcIcFtb21FHHfXjjz9eeOGFZ5xxRmVl5bvvvpum6aOPPtq5c+fq6upt27Z12JVZPmvWrAcf" +
    "fDB3YWbvrbfeWlVVVV5evnz58jRNv//++6lTp1ZXV9fW1m7fvj131fjx4/OeXsbmzZtfeOGFNE13797dq1evvDNFhk8++eRvvvkm" +
    "TdOvv/564MCBeWdGjRr16aefpmn6+++/z5s3r/0Bc5dnL93gwYO3b9+eefjdd9+1P6shQ4a8//77aZq+++67xx133J/75wLgfy7A" +
    "K1euPO+88+rq6jZs2JCm6Zdffjlo0KD2M3l3HX744StXriy0t7S0dNGiRWmabt269dhjj03TdMaMGc8//3yapvX19VdeeWXuqp9/" +
    "/jnv6XXw1FNPXXrppcVncofLyspaW1vTNG1tbc32O3dm4cKF1dXVU6ZM+fzzz9vPFFre0NBw+eWXF7qw7733XpcuXQYOHNilS5dX" +
    "Xnml+KkCcDAFfLeatXfv3pqamn379n3yySebNm0aNmzYli1bMrt++eWX1tbWzp07Zx42Njbm7urcuXNtbW2hvW1tbZdcckmSJH37" +
    "9s18adrU1LRkyZIkSWbMmDFt2rSBAwd2WNW1a9fc08tsz507t6KiIkmSrVu3zp8/f/Xq1XlnXn311bVr11577bVTp07NHc6r/cze" +
    "vXv79Onz9ttvv/TSS3V1dU1NTbfffnvmgIWWL1y4cPHixYX23nDDDc8999y555774osvLl++/Oyzz97fvwkAB0saJ3ujNm/evLlz" +
    "5x5zzDG//vpr5iZvzZo17WeK7Cq0t2vXrh1e6Jhjjvntt9+yT+Zdlff0snbt2jV06NDMfXOhmULDeT9D7jBz4okntrS0pGna0tJS" +
    "VlbW/mh5l2/YsGHy5MlFzrxHjx6Z++aWlpaePXsWOlUADr6/xc+Qamtr33vvvdNPP/3ll19OkuT111+fO3du+4EiuwrtPeSQjm9t" +
    "+PDhDQ0NSZI88cQTt9xyS+6q3bt3FznJNE1nzpw5Z86cESNG7Pcd5Q6fddZZS5cuTZJk6dKlZ511Vt6ZsWPHvvPOO0mSvPPOO4MG" +
    "DWp/wNzlSZLcd999c+bMKXIa/fr1W7duXZIk69evP/744/d72gAcNJ3+/T1wkO7du//0009JkuzZs6e8vLypqenKK6/cs2dPSUnJ" +
    "kiVL+vbtm53Ztm3bFVdckXdXkiTF92a3t27dWldXl7lBfOaZZ3bt2tVh1fjx47O/L8r8xGj48OGZ7YqKipNOOumaa6457bTTkiQ5" +
    "8sgjV6xYkTuTzf+TTz7ZYXjnzp0zZ8784YcfysrKnn766W7duuXONDc319XV7d69u6Sk5LHHHjvhhBOyJ5O7fMuWLRdffHHeHxdl" +
    "3/tHH300e/bsf/8zd+r0wAMPDB48+P/z3xOA/5IAA8A/1t/iI2gA+KcRYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQ" +
    "YAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECA" +
    "ASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEG" +
    "gAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgA" +
    "AggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAI" +
    "IMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCA" +
    "AANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAAC" +
    "DAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggw" +
    "AAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAA" +
    "EECAASCAAANAAAEGgAACDAACDAD/DO6AASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgA" +
    "AggwAAQQYAAIIMAAIMAA8M/gDhgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANA" +
    "AAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAAB" +
    "BBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQ" +
    "YAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECA" +
    "ASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEGgAACDAABBBgAAggwAAQQYAAIIMAAEECAASCAAANAAAEG" +
    "gAACDAABBBgAAggwAAQQYAAIIMAAkBx8/wL0yz6c7xtcOAAAAABJRU5ErkJggg==",
  "base64",
);

function dialog(page: Page, title: string) {
  return page.getByRole("dialog").filter({ hasText: title });
}

test("attachments: upload, reject, delete, and run with a file attached", async ({ page }) => {
  // The live-stack branch waits for a real OCR + agent run.
  if (process.env.E2E_AGENT_NAME || process.env.E2E_AGENT_ID) test.setTimeout(600_000);

  // ---- Login ----
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("button", { name: "Sign in with password" })).toBeHidden();

  // ---- Prerequisites: key, project, prompt, job (same path as smoke) ----
  // E2E_KEY_LABEL reuses a key that already exists on the live stack (a
  // real LibreChat credential the test must not know); otherwise create
  // a throwaway like the smoke does.
  const keyLabel = process.env.E2E_KEY_LABEL ?? `${runTag} key`;
  if (!process.env.E2E_KEY_LABEL) {
    await page.goto("/api-keys");
    await page.getByRole("button", { name: "New Key" }).click();
    const keyDialog = dialog(page, "New API Key");
    await keyDialog.getByLabel("Label (optional)").fill(keyLabel);
    await keyDialog.getByLabel("LibreChat API key").fill("e2e-not-a-real-key");
    await keyDialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(keyLabel)).toBeVisible();
  }

  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  const projectDialog = dialog(page, "New Project");
  await projectDialog.getByLabel("Name").fill(`${runTag} project`);
  await projectDialog.getByRole("button", { name: "Create" }).click();
  await page.getByText(`${runTag} project`).click();

  await page.getByRole("button", { name: "New Prompt" }).click();
  const promptDialog = dialog(page, "New Prompt");
  await promptDialog.getByLabel("Name").fill(`${runTag} prompt`);
  await promptDialog.getByLabel("Prompt content").fill("Summarize the attached document in one sentence.");
  await promptDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(`${runTag} prompt`)).toBeVisible();

  await page.getByRole("button", { name: "New Job" }).click();
  const jobDialog = dialog(page, "New Job");
  await jobDialog.getByRole("textbox", { name: "Name", exact: true }).fill(`${runTag} job`);
  await jobDialog.getByRole("combobox", { name: "Prompt", exact: true }).click();
  await page.getByRole("option", { name: `${runTag} prompt` }).click();
  await jobDialog.getByRole("combobox", { name: "API Key" }).click();
  await page.getByRole("option", { name: new RegExp(keyLabel) }).click();
  // Agent: with LibreChat up (live stack) discovery renders an "Agent"
  // select — pick by E2E_AGENT_NAME; without it (CI) the dialog falls
  // back to the manual Agent-ID field, same as the smoke.
  const agentSelect = jobDialog.getByRole("combobox", { name: "Agent", exact: true });
  if (process.env.E2E_AGENT_NAME) {
    // Discovery fires once a key is selected; the select replaces the
    // manual field only after the agents query resolves — wait for it.
    await agentSelect.waitFor({ state: "visible", timeout: 20_000 });
    await agentSelect.click();
    await page.getByRole("option", { name: new RegExp(process.env.E2E_AGENT_NAME) }).click();
  } else {
    await jobDialog.getByLabel("LibreChat Agent ID").fill(process.env.E2E_AGENT_ID ?? "agent_e2e_not_real");
  }
  await jobDialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText(`${runTag} job`)).toBeVisible();

  // ---- Attachments dialog ----
  const jobRow = page.getByRole("listitem").filter({ hasText: `${runTag} job` });
  await jobRow.getByRole("button", { name: "Files" }).click();
  const filesDialog = dialog(page, "Attachments");
  await expect(filesDialog.getByText("No attachments yet.")).toBeVisible();

  // Reject: wrong type never reaches the API.
  await filesDialog.locator('input[type="file"]').setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  });
  await expect(filesDialog.getByRole("alert")).toContainText("unsupported type");

  // Upload a real PNG.
  await filesDialog.locator('input[type="file"]').setInputFiles({
    name: "tiny-scan.png",
    mimeType: "image/png",
    buffer: TEST_PNG,
  });
  await expect(filesDialog.getByText("tiny-scan.png")).toBeVisible();
  await expect(filesDialog.getByText(/image\/png/)).toBeVisible();

  // Delete it, then put it back (delete path + idempotent re-upload).
  await filesDialog.getByRole("button", { name: "delete tiny-scan.png" }).click();
  await expect(filesDialog.getByText("No attachments yet.")).toBeVisible();
  await filesDialog.locator('input[type="file"]').setInputFiles({
    name: "tiny-scan.png",
    mimeType: "image/png",
    buffer: TEST_PNG,
  });
  await expect(filesDialog.getByText("tiny-scan.png")).toBeVisible();
  await filesDialog.getByRole("button", { name: "Close" }).click();

  // ---- Run with the attachment ----
  await jobRow.getByRole("button", { name: "Runs" }).click();
  const runsDialog = dialog(page, "Run History");
  await runsDialog.getByRole("button", { name: "Run Now" }).click();
  await expect(runsDialog.getByText("Manual")).toBeVisible({ timeout: 30_000 });

  // Live stack only: with a real agent the run SUCCEEDs and the
  // searchable-PDF artifact appears in the expanded run.
  if (process.env.E2E_AGENT_NAME || process.env.E2E_AGENT_ID) {
    // CPU-only stacks cold-load the model: OCR + load + generation can
    // take several minutes. Verified live: the run reaches SUCCESS.
    await expect(runsDialog.getByText("SUCCESS").first()).toBeVisible({ timeout: 480_000 });
    await runsDialog.getByText("SUCCESS").first().click();
    await expect(
      runsDialog.getByRole("link", { name: /tiny-scan\.png\.searchable\.pdf/ }),
    ).toBeVisible({ timeout: 15_000 });
  }
});
