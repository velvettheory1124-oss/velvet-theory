# Editing the live site (one-time setup, about 10 minutes)

After this, you can open the live site on any device, rearrange and add photos,
press **Publish**, and the site updates itself. Nothing needs installing.

How it works: the editor sends your changes to a small function that runs on
Netlify (`netlify/functions/admin.js`). It checks your password, then commits the
change to GitHub, and Netlify redeploys from that commit.

You do the setup **once**, because it needs two accounts only you can sign in to.

---

## Step 1 — a GitHub token (the key that lets the function commit)

1. Sign in to GitHub as the account that owns the repo (`velvettheory1124-oss`).
2. Open https://github.com/settings/personal-access-tokens/new
3. Fill in:
   - **Token name:** `velvet-theory-publish`
   - **Expiration:** 1 year (put a reminder in your calendar to renew it)
   - **Repository access:** *Only select repositories* → `velvet-theory`
   - **Permissions → Repository permissions → Contents:** *Read and write*
     (leave everything else as "No access")
4. Click **Generate token** and copy it (it starts with `github_pat_`). You will
   not see it again.

## Step 2 — three settings in Netlify

Sign in to https://app.netlify.com as the account that owns the **velvet-theory**
site → open the site → **Site configuration → Environment variables → Add a variable**.

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `ADMIN_PASSWORD` | the password you want to log in with (make it long) |
| `SESSION_SECRET` | any long random text, e.g. 40+ random characters |

Optional: `GITHUB_REPO` (default `velvettheory1124-oss/velvet-theory`) and
`GITHUB_BRANCH` (default `main`).

Then **Deploys → Trigger deploy → Deploy site** so the settings take effect.

> Keep the token and password out of chat messages, emails and the repo. They
> belong only in Netlify's settings.

## Step 3 — use it

1. Open the live site with `?edit` on the end:
   **https://velvet-theory.netlify.app/?edit**
   (or press **Ctrl+Shift+A** on a computer and enter your password).
2. Open a category and press **Arrange**.
3. Change what you like. Nothing is public yet.
4. Press **Publish** in the bar at the bottom, type a short note, enter your
   password (asked once, then remembered for 12 hours).
5. Wait about a minute. The button counts the seconds, and the page reloads
   itself when the site is live.

Anyone can open `?edit` and see the editing buttons, but **no one can publish
without your password**: the function refuses every request that does not carry a
valid login.

## Good to know

- **Two people editing:** if someone else publishes while you are editing, your
  Publish is refused with a clear message instead of overwriting their work.
  Reload the page and publish again; your edits are kept in your browser.
- **Photos** are shrunk to 1800px (the size the site uses) before upload, so
  large camera files are fine.
- **Mistakes:** every publish is a normal commit in GitHub, so any version can be
  restored from the repository's history.
- **A drag-and-dropped folder** (the old way of uploading to Netlify) does not
  include the function. Always deploy through GitHub.
- **Phones:** the editor is built for a mouse. Dragging photos with a finger is
  not tested.

## If something goes wrong

| What you see | What it means |
|---|---|
| No Publish button | The settings are missing or the site has not redeployed since you added them. Do step 2 again, then Trigger deploy. |
| "Owner login is not set up" | Same as above. |
| "Incorrect password" | `ADMIN_PASSWORD` in Netlify does not match what you typed. |
| "GitHub: Bad credentials" | The token expired or was typed wrongly. Make a new one (step 1) and update `GITHUB_TOKEN`. |
| "GitHub: Resource not accessible" | The token does not have *Contents: Read and write* on this repo. |
| "published by someone else" | Reload the page and publish again. |
