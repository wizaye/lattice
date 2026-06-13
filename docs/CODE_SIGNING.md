# Code Signing Setup

## Required Secrets

### Windows (Authenticode)
1. `WINDOWS_CERTIFICATE` - Base64-encoded PFX certificate
   ```bash
   base64 -i certificate.pfx | pbcopy
   ```
2. `WINDOWS_CERTIFICATE_PASSWORD` - Certificate password

**Obtaining Certificate:**
- Purchase from DigiCert, Sectigo, or similar CA
- Or use free alternatives like Let's Encrypt (for OV certificates)

### macOS (Developer ID)
1. `MACOS_CERTIFICATE` - Base64-encoded P12 certificate
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```
2. `MACOS_CERTIFICATE_PASSWORD` - Certificate password
3. `APPLE_ID` - Your Apple ID email
4. `APPLE_PASSWORD` - App-specific password
5. `APPLE_TEAM_ID` - Your team ID from Apple Developer

**Obtaining Certificate:**
1. Join Apple Developer Program ($99/year)
2. Create "Developer ID Application" certificate in Xcode
3. Export as P12 with password

### Linux (GPG)
1. `GPG_PRIVATE_KEY` - Base64-encoded GPG private key
   ```bash
   gpg --armor --export-secret-keys KEY_ID | base64 | pbcopy
   ```
2. `GPG_PASSPHRASE` - GPG key passphrase

**Creating GPG Key:**
```bash
gpg --full-generate-key
# Choose RSA and RSA, 4096 bits, no expiration
# Use your real name and email
gpg --list-secret-keys --keyid-format LONG
# Export public key for distribution
gpg --armor --export KEY_ID > public.asc
```

## Setting Secrets in GitHub

1. Go to repository Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret with exact name as above

## Verifying Signatures

### Windows
```powershell
Get-AuthenticodeSignature lattice.exe | Format-List *
```

### macOS
```bash
codesign -dvv Lattice.app
spctl -a -vv Lattice.app
```

### Linux
```bash
gpg --verify lattice_0.1.0_amd64.deb.asc lattice_0.1.0_amd64.deb
```

## Distribution Public Keys

### GPG Public Key
Upload `public.asc` to:
- https://keys.openpgp.org/
- https://keyserver.ubuntu.com/
- Include in repository as `KEYS` file

### Windows/macOS
Certificates are validated automatically via system trust stores.

## Auto-Update Configuration

Add to `tauri.conf.json`:
```json
{
  "plugins": {
    "updater": {
      "active": true,
      "endpoints": [
        "https://github.com/vijaygatla/lattice/releases/latest/download/latest.json"
      ],
      "dialog": true,
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

Generate updater keys:
```bash
tauri signer generate -w ~/.tauri/lattice.key
# Add public key to tauri.conf.json
# Add private key to CI secrets as TAURI_PRIVATE_KEY
```
