import { GraphQLSchema, isObjectType, FieldNode, GraphQLError } from 'graphql';

import { logServiceAndType, errorWithCode } from '../../utils';

/**
 *  for every field in a @provides, there should be a matching @external
 */
export const providesFieldsMissingExternal = (schema: GraphQLSchema) => {
  const errors: GraphQLError[] = [];

  const types = schema.getTypeMap();
  for (const [typeName, namedType] of Object.entries(types)) {
    // Only object types have fields
    if (!isObjectType(namedType)) continue;

    // for each field, if there's a requires on it, check that there's a matching
    // @external field, and that the types referenced are from the base type
    for (const [fieldName, field] of Object.entries(namedType.getFields())) {
      const serviceName = field.federation && field.federation.serviceName;

      // serviceName should always exist on fields that have @provides federation data, since
      // the only case where serviceName wouldn't exist is on a base type, and in that case,
      // the `provides` metadata should never get added to begin with. This should be caught in
      // composition work. This kind of error should be validated _before_ composition.
      if (!serviceName) continue;

      const externalFieldsOnTypeForService =
        namedType.federation &&
        namedType.federation.externals &&
        namedType.federation.externals[serviceName];
      if (field.federation && field.federation.provides) {
        const selections = field.federation.provides as FieldNode[];
        for (const selection of selections) {
          const foundMatchingExternal = externalFieldsOnTypeForService
            ? externalFieldsOnTypeForService.some(
                ext => ext.field.name.value === selection.name.value,
              )
            : undefined;
          if (!foundMatchingExternal) {
            errors.push(
              errorWithCode(
                'PROVIDES_FIELDS_MISSING_EXTERNAL',
                logServiceAndType(serviceName, typeName, fieldName) +
                  `provides the field \`${selection.name.value}\` and requires ${typeName}.${selection.name.value} to be marked as @external.`,
              ),
            );
          }
        }
      }
    }
  }

  return errors;
};
