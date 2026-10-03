//! Small domain-separated COSE claims for contact and invitation handshakes.
use crate::{Error, Identity, Result, codec};
use coset::{CborSerializable, CoseSign1, CoseSign1Builder, HeaderBuilder, iana};
use ed25519_dalek::{Signature, Signer, VerifyingKey};
use serde::{Serialize, de::DeserializeOwned};

impl Identity {
    pub fn claim<T: Serialize>(&self, domain: &[u8], value: &T) -> Result<String> {
        let signed = CoseSign1Builder::new()
            .protected(
                HeaderBuilder::new()
                    .algorithm(iana::Algorithm::EdDSA)
                    .key_id(hex::decode(self.public_key()).map_err(|_| Error::Signature)?)
                    .build(),
            )
            .payload(codec::encode(value)?)
            .create_signature(domain, |bytes| self.0.sign(bytes).to_bytes().to_vec())
            .build()
            .to_vec()
            .map_err(|_| Error::Encoding)?;
        codec::check(&signed)?;
        Ok(hex::encode(signed))
    }
}

pub fn verify<T: DeserializeOwned>(domain: &[u8], value: &str) -> Result<(String, T)> {
    if value.len() > crate::limits::MAX_EVENT_BYTES * 2 {
        return Err(Error::Limit);
    }
    let bytes = hex::decode(value).map_err(|_| Error::Encoding)?;
    codec::check(&bytes)?;
    let signed = CoseSign1::from_slice(&bytes).map_err(|_| Error::Encoding)?;
    let key_bytes: [u8; 32] = signed
        .protected
        .header
        .key_id
        .as_slice()
        .try_into()
        .map_err(|_| Error::Signature)?;
    if signed.protected.header
        != HeaderBuilder::new()
            .algorithm(iana::Algorithm::EdDSA)
            .key_id(key_bytes.to_vec())
            .build()
        || signed.unprotected != Default::default()
    {
        return Err(Error::Encoding);
    }
    codec::check(
        signed
            .protected
            .original_data
            .as_deref()
            .ok_or(Error::Encoding)?,
    )?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| Error::Signature)?;
    signed.verify_signature(domain, |sig, data| {
        key.verify_strict(
            data,
            &Signature::from_slice(sig).map_err(|_| Error::Signature)?,
        )
        .map_err(|_| Error::Signature)
    })?;
    Ok((
        hex::encode(key_bytes),
        codec::decode(signed.payload.as_deref().ok_or(Error::Encoding)?)?,
    ))
}
