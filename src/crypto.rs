use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, AeadCore, OsRng},
};
use anyhow::{Result, anyhow};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Clone)]
pub struct Vault(Aes256Gcm);
impl Vault {
    pub fn new(key: &str) -> Result<Self> {
        let key = STANDARD
            .decode(key)
            .map_err(|_| anyhow!("RELAY_MASTER_KEY must be base64"))?;
        Ok(Self(Aes256Gcm::new_from_slice(&key).map_err(|_| {
            anyhow!("master key must decode to 32 bytes")
        })?))
    }
    pub fn seal(&self, value: &str) -> Result<String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let encrypted = self
            .0
            .encrypt(&nonce, value.as_bytes())
            .map_err(|_| anyhow!("encryption failed"))?;
        Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
    }
    pub fn open(&self, value: &str) -> Result<String> {
        let data = STANDARD.decode(value)?;
        anyhow::ensure!(data.len() >= 28, "invalid ciphertext");
        let plain = self
            .0
            .decrypt(data[..12].into(), &data[12..])
            .map_err(|_| anyhow!("decryption failed; check master key"))?;
        Ok(String::from_utf8(plain)?)
    }
}
