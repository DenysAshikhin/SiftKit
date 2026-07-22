import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  type OptionalJsonValue,
} from '../lib/json-types.js';
import type { LlamaCppResponseFormat } from '../llm-protocol/types.js';
import type { InferenceBackendId } from '../config/types.js';

export class FormatronSchemaLowerer {
  lowerResponseFormat(responseFormat: LlamaCppResponseFormat): LlamaCppResponseFormat {
    if (responseFormat.type !== 'json_schema') {
      return responseFormat;
    }
    const schema = responseFormat.json_schema.schema;
    if (!isJsonObject(schema)) {
      return responseFormat;
    }
    return {
      type: 'json_schema',
      json_schema: {
        ...responseFormat.json_schema,
        schema: this.lowerSchema(schema, false),
      },
    };
  }

  private lowerSchema(schema: JsonObject, removeMinItems: boolean): JsonObject {
    const lowered: MutableJsonObject = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'minItems' && removeMinItems) {
        continue;
      }
      lowered[key] = this.lowerKeyword(key, value);
    }

    const properties = this.getObject(schema.properties);
    if (!properties) {
      return lowered;
    }
    const required = new Set(this.getStringArray(schema.required));
    const action = this.getObject(properties.action)?.const;
    const loweredProperties: MutableJsonObject = {};
    for (const [name, value] of Object.entries(properties)) {
      const propertySchema = this.getObject(value);
      if (!propertySchema) {
        loweredProperties[name] = value;
        continue;
      }
      const loweredProperty = this.lowerSchema(propertySchema, action === 'tool_batch' && name === 'calls');
      loweredProperties[name] = required.has(name) ? loweredProperty : { anyOf: [loweredProperty, { type: 'null' }] };
    }
    lowered.properties = loweredProperties;
    lowered.required = Object.keys(properties);
    return lowered;
  }

  private lowerKeyword(key: string, value: JsonValue): JsonValue {
    if (key === 'properties') {
      return value;
    }
    if (key === 'items' && isJsonObject(value)) {
      return this.lowerSchema(value, false);
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      return value.map((entry) => (isJsonObject(entry) ? this.lowerSchema(entry, false) : entry));
    }
    return value;
  }

  private getObject(value: OptionalJsonValue): JsonObject | null {
    return isJsonObject(value) ? value : null;
  }

  private getStringArray(value: OptionalJsonValue): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }
}

const formatronSchemaLowerer = new FormatronSchemaLowerer();

export function lowerResponseFormatForBackend(
  backend: InferenceBackendId,
  responseFormat: LlamaCppResponseFormat,
): LlamaCppResponseFormat {
  return backend === 'exl3' ? formatronSchemaLowerer.lowerResponseFormat(responseFormat) : responseFormat;
}
