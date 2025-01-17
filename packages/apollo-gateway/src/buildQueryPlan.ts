import {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  getNamedType,
  getOperationRootType,
  GraphQLAbstractType,
  GraphQLCompositeType,
  GraphQLError,
  GraphQLField,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLType,
  InlineFragmentNode,
  isAbstractType,
  isCompositeType,
  isIntrospectionType,
  isListType,
  isNamedType,
  isObjectType,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  typeFromAST,
  TypeInfo,
  TypeNameMetaFieldDef,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import {
  Field,
  FieldSet,
  groupByParentType,
  groupByResponseName,
  matchesField,
  selectionSetFromFieldSet,
} from './FieldSet';
import {
  FetchNode,
  PlanNode,
  QueryPlan,
  ResponsePath,
  VariableUsage,
  OperationContext,
  FragmentMap,
} from './QueryPlan';
import { getFieldDef, getResponseName } from './utilities/graphql';
import { MultiMap } from './utilities/MultiMap';

const typenameField = {
  kind: Kind.FIELD,
  name: {
    kind: Kind.NAME,
    value: TypeNameMetaFieldDef.name,
  },
};

export function buildQueryPlan(operationContext: OperationContext): QueryPlan {
  const context = buildQueryPlanningContext(operationContext);

  if (context.operation.operation === 'subscription') {
    throw new GraphQLError(
      'Query planning does not support subscriptions for now.',
      [context.operation],
    );
  }

  const rootType = getOperationRootType(context.schema, context.operation);

  const isMutation = context.operation.operation === 'mutation';

  const fields = collectFields(
    context,
    rootType,
    context.operation.selectionSet,
  );

  // Mutations are a bit more specific in how FetchGroups can be built, as some
  // calls to the same service may need to be executed serially.
  const groups = isMutation
    ? splitRootFieldsSerially(context, fields)
    : splitRootFields(context, fields);

  const nodes = groups.map(group =>
    executionNodeForGroup(context, group, rootType),
  );

  return {
    kind: 'QueryPlan',
    node: isMutation
      ? wrapInSequenceNodeIfNeeded(nodes)
      : wrapInParallelNodeIfNeeded(nodes),
  };
}

function executionNodeForGroup(
  context: QueryPlanningContext,
  group: FetchGroup,
  parentType?: GraphQLCompositeType,
): PlanNode {
  const selectionSet = selectionSetFromFieldSet(group.fields, parentType);

  const fetchNode: FetchNode = {
    kind: 'Fetch',
    serviceName: group.serviceName,
    selectionSet,
    requires:
      group.requiredFields && group.requiredFields.length > 0
        ? selectionSetFromFieldSet(group.requiredFields)
        : undefined,
    variableUsages: context.getVariableUsages(selectionSet),
  };

  const node: PlanNode =
    group.mergeAt && group.mergeAt.length > 0
      ? {
          kind: 'Flatten',
          path: group.mergeAt,
          node: fetchNode,
        }
      : fetchNode;

  if (group.dependentGroups.length > 0) {
    const dependentNodes = group.dependentGroups.map(dependentGroup =>
      executionNodeForGroup(context, dependentGroup),
    );
    return {
      kind: 'Sequence',
      nodes: [node, wrapInParallelNodeIfNeeded(dependentNodes)],
    };
  } else {
    return node;
  }
}

function wrapInParallelNodeIfNeeded(nodes: PlanNode[]): PlanNode {
  return nodes.length > 1
    ? {
        kind: 'Parallel',
        nodes: nodes,
      }
    : nodes[0];
}

function wrapInSequenceNodeIfNeeded(nodes: PlanNode[]): PlanNode {
  return nodes.length > 1
    ? {
        kind: 'Sequence',
        nodes: nodes,
      }
    : nodes[0];
}

function splitRootFields(
  context: QueryPlanningContext,
  fields: FieldSet,
): FetchGroup[] {
  const groupsByService: {
    [serviceName: string]: FetchGroup;
  } = Object.create(null);

  function groupForService(serviceName: string) {
    let group = groupsByService[serviceName];

    if (!group) {
      group = new FetchGroup(serviceName);
      groupsByService[serviceName] = group;
    }

    return group;
  }

  splitFields(context, [], fields, field => {
    const { parentType, fieldNode, fieldDef } = field;

    const owningService = context.getOwningService(parentType, fieldDef);

    if (!owningService) {
      throw new GraphQLError(
        `Couldn't find owning service for field "${parentType.name}.${fieldDef.name}"`,
        fieldNode,
      );
    }

    return groupForService(owningService);
  });

  return Object.values(groupsByService);
}

// For mutations, we need to respect the order of the fields, in order to
// determine which fields can be batched together in the same request. If
// they're "split" by fields belonging to other services, then we need to manage
// the proper sequencing at the gateway level. In this example, we need 3
// FetchGroups (requests) in sequence:
//
//    mutation abc {
//      createReview() # reviews service (1)
//      updateReview() # reviews service (1)
//      login() # account service (2)
//      deleteReview() # reviews service (3)
//    }
function splitRootFieldsSerially(
  context: QueryPlanningContext,
  fields: FieldSet,
): FetchGroup[] {
  const fetchGroups: FetchGroup[] = [];

  function groupForField(serviceName: string) {
    let group: FetchGroup;

    // If the most recent FetchGroup in the array belongs to the same service,
    // the field in question can be batched within that group.
    const previousGroup = fetchGroups[fetchGroups.length - 1];
    if (previousGroup && previousGroup.serviceName === serviceName) {
      return previousGroup;
    }

    // If there's no previous group, or the previous group is from a different
    // service, then we need to add a new FetchGroup.
    group = new FetchGroup(serviceName);
    fetchGroups.push(group);

    return group;
  }

  splitFields(context, [], fields, field => {
    const { parentType, fieldNode, fieldDef } = field;

    const owningService = context.getOwningService(parentType, fieldDef);

    if (!owningService) {
      throw new GraphQLError(
        `Couldn't find owning service for field "${parentType.name}.${fieldDef.name}"`,
        fieldNode,
      );
    }

    return groupForField(owningService);
  });

  return fetchGroups;
}

function splitSubfields(
  context: QueryPlanningContext,
  path: ResponsePath,
  fields: FieldSet,
  parentGroup: FetchGroup,
) {
  splitFields(context, path, fields, field => {
    const { parentType, fieldNode, fieldDef } = field;

    const baseService = context.getBaseService(parentType);

    if (!baseService) {
      throw new GraphQLError(
        `Couldn't find base service for type "${parentType.name}"`,
        fieldNode,
      );
    }

    const owningService = context.getOwningService(parentType, fieldDef);

    if (!owningService) {
      throw new GraphQLError(
        `Couldn't find owning service for field "${parentType.name}.${fieldDef.name}"`,
        fieldNode,
      );
    }

    // Is the field defined on the base service?
    if (owningService === baseService) {
      // Can we fetch the field from the parent group?
      if (
        owningService === parentGroup.serviceName ||
        parentGroup.providedFields.some(matchesField(field))
      ) {
        return parentGroup;
      } else {
        // We need to fetch the key fields from the parent group first, and then
        // use a dependent fetch from the owning service.
        const keyFields = context.getKeyFields(parentType, owningService);
        return parentGroup.dependentGroupForService(owningService, keyFields);
      }
    } else {
      // It's an extension field, so we need to fetch the required fields first.
      const requiredFields = context.getRequiredFields(
        parentType,
        fieldDef,
        owningService,
      );

      // Can we fetch the required fields from the parent group?
      if (
        requiredFields.every(requiredField =>
          parentGroup.providedFields.some(matchesField(requiredField)),
        )
      ) {
        return parentGroup.dependentGroupForService(
          owningService,
          requiredFields,
        );
      } else {
        // We need to go through the base group first.

        const keyFields = context.getKeyFields(parentType, baseService);

        if (!keyFields) {
          throw new GraphQLError(
            `Couldn't find keys for type "${parentType.name}}" in service "${baseService}"`,
            fieldNode,
          );
        }

        const baseGroup = parentGroup.dependentGroupForService(
          baseService,
          keyFields,
        );

        return baseGroup.dependentGroupForService(
          owningService,
          requiredFields,
        );
      }
    }
  });
}

function splitFields(
  context: QueryPlanningContext,
  path: ResponsePath,
  fields: FieldSet,
  groupForField: (field: Field<GraphQLObjectType>) => FetchGroup,
) {
  for (const fieldsForResponseName of groupByResponseName(fields).values()) {
    for (const [parentType, fieldsForParentType] of groupByParentType(
      fieldsForResponseName,
    )) {
      // Field nodes that share the same response name and parent type are guaranteed
      // to have the same field name and arguments. We only need the other nodes when
      // merging selection sets, to take node-specific subfields and directives
      // into account.

      const field = fieldsForParentType[0];
      const { fieldDef } = field;

      // We skip `__typename`.
      if (fieldDef.name === TypeNameMetaFieldDef.name) {
        continue;
      }

      // We skip introspection fields like `__schema` and `__type`.
      if (isIntrospectionType(getNamedType(fieldDef.type))) {
        continue;
      }

      if (isObjectType(parentType)) {
        // If parent type is an object type, we can directly look for the right
        // group.
        const group = groupForField(field as Field<GraphQLObjectType>);
        group.fields.push(
          completeField(
            context,
            parentType,
            group,
            path,
            fieldsForResponseName,
          ),
        );
      } else {
        // For interfaces however, we need to look at all possible runtime types.

        // We keep track of which possible runtime parent types can be fetched
        // from which group,
        const groupsByRuntimeParentTypes = new MultiMap<
          FetchGroup,
          GraphQLObjectType
        >();

        for (const runtimeParentType of context.getPossibleTypes(parentType)) {
          const fieldDef = context.getFieldDef(
            runtimeParentType,
            field.fieldNode,
          );
          groupsByRuntimeParentTypes.add(
            groupForField({
              parentType: runtimeParentType,
              fieldNode: field.fieldNode,
              fieldDef,
            }),
            runtimeParentType,
          );
        }

        // If all possible runtime parent types can be fetched from the same
        // group, we'll assume we can add the field once for the interface.
        if (groupsByRuntimeParentTypes.size === 1) {
          // FIXME: We should make sure the group's service supports the
          // interface, because even if it owns all possible types it may not
          // actually contain the interface.
          const group = groupsByRuntimeParentTypes.keys().next().value;
          group.fields.push(
            completeField(
              context,
              parentType,
              group,
              path,
              fieldsForResponseName,
            ),
          );
        } else {
          // If not, we add the field separately for each runtime parent type.
          for (const [
            group,
            runtimeParentTypes,
          ] of groupsByRuntimeParentTypes) {
            for (const runtimeParentType of runtimeParentTypes) {
              group.fields.push(
                completeField(
                  context,
                  runtimeParentType,
                  group,
                  path,
                  fieldsForResponseName,
                ),
              );
            }
          }
        }
      }
    }
  }
}

function completeField(
  context: QueryPlanningContext,
  parentType: GraphQLCompositeType,
  parentGroup: FetchGroup,
  path: ResponsePath,
  fields: FieldSet,
): Field {
  const { fieldNode, fieldDef } = fields[0];
  const returnType = getNamedType(fieldDef.type);

  if (!isCompositeType(returnType)) {
    // FIXME: We should look at all field nodes to make sure we take directives
    // into account (or remove directives for the time being).
    return { parentType, fieldNode, fieldDef };
  } else {
    // For composite types, we need to recurse.

    const fieldPath = addPath(path, getResponseName(fieldNode), fieldDef.type);

    const subGroup = new FetchGroup(parentGroup.serviceName);
    subGroup.mergeAt = fieldPath;

    subGroup.providedFields = context.getProvidedFields(
      fieldDef,
      parentGroup.serviceName,
    );

    // For abstract types, we always need to request `__typename`
    if (isAbstractType(returnType)) {
      subGroup.fields.push({
        parentType: returnType,
        fieldNode: typenameField,
        fieldDef: TypeNameMetaFieldDef,
      });
    }

    const subfields = collectSubfields(context, returnType, fields);
    splitSubfields(context, fieldPath, subfields, subGroup);

    parentGroup.otherDependentGroups.push(...subGroup.dependentGroups);

    return {
      parentType,
      fieldNode: {
        ...fieldNode,
        selectionSet: selectionSetFromFieldSet(subGroup.fields, returnType),
      },
      fieldDef,
    };
  }
}

function collectFields(
  context: QueryPlanningContext,
  parentType: GraphQLCompositeType,
  selectionSet: SelectionSetNode,
  fields: FieldSet = [],
  visitedFragmentNames: { [fragmentName: string]: boolean } = Object.create(
    null,
  ),
): FieldSet {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        const fieldDef = context.getFieldDef(parentType, selection);
        fields.push({ parentType, fieldNode: selection, fieldDef });
        break;
      case Kind.INLINE_FRAGMENT:
        collectFields(
          context,
          getFragmentCondition(selection),
          selection.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
      case Kind.FRAGMENT_SPREAD:
        const fragmentName = selection.name.value;

        if (visitedFragmentNames[fragmentName]) {
          continue;
        }
        visitedFragmentNames[fragmentName] = true;

        const fragment = context.fragments[fragmentName];
        if (!fragment) {
          continue;
        }

        collectFields(
          context,
          getFragmentCondition(fragment),
          fragment.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
    }
  }

  return fields;

  function getFragmentCondition(
    fragment: FragmentDefinitionNode | InlineFragmentNode,
  ): GraphQLCompositeType {
    const typeConditionNode = fragment.typeCondition;
    if (!typeConditionNode) return parentType;

    return typeFromAST(
      context.schema,
      typeConditionNode,
    ) as GraphQLCompositeType;
  }
}

// Collecting subfields collapses parent types, because it merges
// selection sets without taking the runtime parent type of the field
// into account. If we want to keep track of multiple levels of possible
// types, this is where that would need to happen.
export function collectSubfields(
  context: QueryPlanningContext,
  returnType: GraphQLCompositeType,
  fields: FieldSet,
): FieldSet {
  let subfields: FieldSet = [];
  const visitedFragmentNames = Object.create(null);

  for (const field of fields) {
    const selectionSet = field.fieldNode.selectionSet;

    if (selectionSet) {
      subfields = collectFields(
        context,
        returnType,
        selectionSet,
        subfields,
        visitedFragmentNames,
      );
    }
  }

  return subfields;
}

class FetchGroup {
  constructor(
    public readonly serviceName: string,
    public readonly fields: FieldSet = [],
  ) {}

  requiredFields: FieldSet = [];
  providedFields: FieldSet = [];

  mergeAt?: ResponsePath;

  private dependentGroupsByService: {
    [serviceName: string]: FetchGroup;
  } = Object.create(null);
  public otherDependentGroups: FetchGroup[] = [];

  dependentGroupForService(serviceName: string, requiredFields: FieldSet) {
    let group = this.dependentGroupsByService[serviceName];

    if (!group) {
      group = new FetchGroup(serviceName);
      group.mergeAt = this.mergeAt;
      this.dependentGroupsByService[serviceName] = group;
    }

    if (requiredFields) {
      if (group.requiredFields) {
        group.requiredFields.push(...requiredFields);
      } else {
        group.requiredFields = requiredFields;
      }
      this.fields.push(...requiredFields);
    }

    return group;
  }

  get dependentGroups() {
    return [
      ...Object.values(this.dependentGroupsByService),
      ...this.otherDependentGroups,
    ];
  }
}

// Adapted from buildExecutionContext in graphql-js
export function buildOperationContext(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName?: string,
): OperationContext {
  let operation: OperationDefinitionNode | undefined;
  const fragments: {
    [fragmentName: string]: FragmentDefinitionNode;
  } = Object.create(null);
  document.definitions.forEach(definition => {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (!operationName && operation) {
          throw new GraphQLError(
            'Must provide operation name if query contains ' +
              'multiple operations.',
          );
        }
        if (
          !operationName ||
          (definition.name && definition.name.value === operationName)
        ) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition;
        break;
    }
  });
  if (!operation) {
    if (operationName) {
      throw new GraphQLError(`Unknown operation named "${operationName}".`);
    } else {
      throw new GraphQLError('Must provide an operation.');
    }
  }

  return { schema, operation, fragments };
}

export function buildQueryPlanningContext({
  operation,
  schema,
  fragments,
}: OperationContext): QueryPlanningContext {
  return new QueryPlanningContext(schema, operation, fragments);
}

export class QueryPlanningContext {
  constructor(
    public readonly schema: GraphQLSchema,
    public readonly operation: OperationDefinitionNode,
    public readonly fragments: FragmentMap,
  ) {}

  getFieldDef(parentType: GraphQLCompositeType, fieldNode: FieldNode) {
    const fieldName = fieldNode.name.value;

    const fieldDef = getFieldDef(this.schema, parentType, fieldName);

    if (!fieldDef) {
      throw new GraphQLError(
        `Cannot query field "${fieldNode.name.value}" on type "${String(
          parentType,
        )}"`,
        fieldNode,
      );
    }

    return fieldDef;
  }

  getPossibleTypes(
    type: GraphQLAbstractType | GraphQLObjectType,
  ): ReadonlyArray<GraphQLObjectType> {
    return isAbstractType(type) ? this.schema.getPossibleTypes(type) : [type];
  }

  getVariableUsages(selectionSet: SelectionSetNode): VariableUsage[] {
    const usages: VariableUsage[] = [];
    // FIXME: we could do less work here by caching the extraction of variable definitions
    // instead doing that work for each node
    const node = {
      ...this.operation,
      selectionSet,
    };
    const defaultOperationVariables: { [name: string]: any } = Object.create(
      null,
    );
    const typeInfo = new TypeInfo(this.schema);
    visit(
      node,
      visitWithTypeInfo(typeInfo, {
        VariableDefinition: definition => {
          if (definition.defaultValue) {
            const { value } = definition.variable.name;
            defaultOperationVariables[
              value
            ] = (definition.defaultValue as any).value;
          }
          // return false so that Variable isn't called for this node
          return false;
        },
        Variable(variable) {
          usages.push({
            node: variable,
            type: typeInfo.getInputType()!,
            // prefer defaults variables from the operation over the schema
            defaultValue:
              defaultOperationVariables[variable.name.value] ||
              typeInfo.getDefaultValue(),
          });
        },
      }),
    );
    return usages;
  }

  getBaseService(parentType: GraphQLObjectType): string | null {
    return (parentType.federation && parentType.federation.serviceName) || null;
  }

  getOwningService(
    parentType: GraphQLObjectType,
    fieldDef: GraphQLField<any, any>,
  ): string | null {
    if (fieldDef.federation && fieldDef.federation.serviceName) {
      return fieldDef.federation.serviceName;
    } else {
      return this.getBaseService(parentType);
    }
  }

  getKeyFields(
    parentType: GraphQLCompositeType,
    serviceName: string,
  ): FieldSet {
    const keyFields: FieldSet = [];

    keyFields.push({
      parentType,
      fieldNode: typenameField,
      fieldDef: TypeNameMetaFieldDef,
    });

    for (const possibleType of this.getPossibleTypes(parentType)) {
      const keys =
        possibleType.federation &&
        possibleType.federation.keys &&
        possibleType.federation.keys[serviceName] &&
        possibleType.federation.keys[serviceName];

      if (!(keys && keys.length > 0)) continue;

      keyFields.push(
        ...collectFields(this, possibleType, {
          kind: Kind.SELECTION_SET,
          selections: keys[0],
        }),
      );
    }

    return keyFields;
  }

  getRequiredFields(
    parentType: GraphQLCompositeType,
    fieldDef: GraphQLField<any, any>,
    serviceName: string,
  ): FieldSet {
    const requiredFields: FieldSet = [];

    requiredFields.push(...this.getKeyFields(parentType, serviceName));

    if (fieldDef.federation && fieldDef.federation.requires) {
      requiredFields.push(
        ...collectFields(this, parentType, {
          kind: Kind.SELECTION_SET,
          selections: fieldDef.federation.requires,
        }),
      );
    }

    return requiredFields;
  }

  getProvidedFields(
    fieldDef: GraphQLField<any, any>,
    serviceName: string,
  ): FieldSet {
    const returnType = getNamedType(fieldDef.type);
    if (!isCompositeType(returnType)) return [];

    const providedFields: FieldSet = [];

    providedFields.push(...this.getKeyFields(returnType, serviceName));

    if (fieldDef.federation && fieldDef.federation.provides) {
      providedFields.push(
        ...collectFields(this, returnType, {
          kind: Kind.SELECTION_SET,
          selections: fieldDef.federation.provides,
        }),
      );
    }

    return providedFields;
  }
}

function addPath(path: ResponsePath, responseName: string, type: GraphQLType) {
  path = [...path, responseName];

  while (!isNamedType(type)) {
    if (isListType(type)) {
      path.push('@');
    }

    type = type.ofType;
  }

  return path;
}
