//! Restricted deterministic CBOR: no tags, floats, duplicate keys or indefinite
//! encoding. Parsing depth is bounded before a general CBOR decoder sees input.
use crate::{Error, Result, limits};
use ciborium::value::Value;
use serde::{Serialize, de::DeserializeOwned};

pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let value = Value::serialized(value).map_err(|_| Error::Encoding)?;
    raw(&normalize(value, 0)?)
}

fn raw(value: &Value) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes).map_err(|_| Error::Encoding)?;
    if bytes.len() > limits::MAX_EVENT_BYTES {
        return Err(Error::Limit);
    }
    Ok(bytes)
}

fn normalize(value: Value, depth: usize) -> Result<Value> {
    if depth > limits::MAX_NESTING {
        return Err(Error::Limit);
    }
    Ok(match value {
        Value::Map(values) => {
            let mut entries = Vec::with_capacity(values.len());
            for (key, value) in values {
                let key = normalize(key, depth + 1)?;
                entries.push((raw(&key)?, key, normalize(value, depth + 1)?));
            }
            // RFC 8949 core deterministic bytewise lexicographic key ordering.
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                return Err(Error::Encoding);
            }
            Value::Map(entries.into_iter().map(|(_, k, v)| (k, v)).collect())
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|v| normalize(v, depth + 1))
                .collect::<Result<_>>()?,
        ),
        Value::Float(_) | Value::Tag(_, _) => return Err(Error::Encoding),
        other => other,
    })
}

pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    check(bytes)?;
    ciborium::from_reader(bytes).map_err(|_| Error::Encoding)
}

pub fn check(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > limits::MAX_EVENT_BYTES {
        return Err(Error::Limit);
    }
    let mut position = 0;
    scan(bytes, &mut position, 0)?;
    if position != bytes.len() {
        return Err(Error::Encoding);
    }
    let value: Value = ciborium::from_reader(bytes).map_err(|_| Error::Encoding)?;
    if raw(&normalize(value, 0)?)? != bytes {
        return Err(Error::Encoding);
    }
    Ok(())
}

fn scan(bytes: &[u8], at: &mut usize, depth: usize) -> Result<()> {
    if depth > limits::MAX_NESTING {
        return Err(Error::Limit);
    }
    let header = *bytes.get(*at).ok_or(Error::Encoding)?;
    *at += 1;
    let major = header >> 5;
    let info = header & 31;
    if major == 7 {
        return if matches!(info, 20..=22) {
            Ok(())
        } else {
            Err(Error::Encoding)
        };
    }
    if major == 6 || info > 27 {
        return Err(Error::Encoding);
    }
    let count = if info < 24 {
        u64::from(info)
    } else {
        let len = 1usize << (info - 24);
        let end = at.checked_add(len).ok_or(Error::Limit)?;
        let mut value = 0u64;
        for byte in bytes.get(*at..end).ok_or(Error::Encoding)? {
            value = (value << 8) | u64::from(*byte);
        }
        *at = end;
        value
    };
    match major {
        0 | 1 => Ok(()),
        2 | 3 => {
            let len = usize::try_from(count).map_err(|_| Error::Limit)?;
            *at = at.checked_add(len).ok_or(Error::Limit)?;
            if *at > bytes.len() {
                Err(Error::Encoding)
            } else {
                Ok(())
            }
        }
        4 | 5 => {
            let items = count
                .checked_mul(if major == 5 { 2 } else { 1 })
                .ok_or(Error::Limit)?;
            if items > 1024 {
                return Err(Error::Limit);
            }
            for _ in 0..items {
                scan(bytes, at, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(Error::Encoding),
    }
}
