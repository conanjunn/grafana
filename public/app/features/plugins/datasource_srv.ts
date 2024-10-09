import {
  AppEvents,
  DataSourceApi,
  DataSourceInstanceSettings,
  DataSourceRef,
  DataSourceSelectItem,
  ScopedVars,
  matchPluginId,
} from '@grafana/data';
import {
  DataSourceSrv as DataSourceService,
  getBackendSrv,
  GetDataSourceListFilters,
  getDataSourceSrv as getDataSourceService,
  getLegacyAngularInjector,
  getTemplateSrv,
  TemplateSrv,
} from '@grafana/runtime';
import { ExpressionDatasourceRef, isExpressionReference } from '@grafana/runtime/src/utils/DataSourceWithBackend';
import appEvents from 'app/core/app_events';
import config from 'app/core/config';
import {
  dataSource as expressionDatasource,
  instanceSettings as expressionInstanceSettings,
} from 'app/features/expressions/ExpressionDatasource';
import { ExpressionDatasourceUID } from 'app/features/expressions/types';

import { importDataSourcePlugin } from './plugin_loader';

export class DatasourceSrv implements DataSourceService {
  private datasources: Record<string, DataSourceApi> = {}; // UID
  private settingsMapByName: Record<string, DataSourceInstanceSettings> = {};
  private settingsMapByUid: Record<string, DataSourceInstanceSettings> = {};
  private settingsMapById: Record<string, DataSourceInstanceSettings> = {};
  private defaultName = ''; // actually UID

  constructor(private templateSrv: TemplateSrv = getTemplateSrv()) {}

  init(settingsMapByName: Record<string, DataSourceInstanceSettings>, defaultName: string) {
    this.datasources = {};
    this.settingsMapByUid = {};
    this.settingsMapByName = settingsMapByName; // 一个map，key是DataSource的name，value是具体信息
    this.defaultName = defaultName;

    for (const dsSettings of Object.values(settingsMapByName)) {
      if (!dsSettings.uid) {
        dsSettings.uid = dsSettings.name; // -- Grafana --, -- Mixed etc
      }

      this.settingsMapByUid[dsSettings.uid] = dsSettings; // 一个map，key是DataSource的uid，value是具体信息
      this.settingsMapById[dsSettings.id] = dsSettings; // 一个map，key是DataSource的id，value是具体信息
    }

    // Preload expressions
    this.datasources[ExpressionDatasourceRef.type] = expressionDatasource as any;
    this.datasources[ExpressionDatasourceUID] = expressionDatasource as any;
    this.settingsMapByUid[ExpressionDatasourceRef.uid] = expressionInstanceSettings;
    this.settingsMapByUid[ExpressionDatasourceUID] = expressionInstanceSettings;
  }

  getDataSourceSettingsByUid(uid: string): DataSourceInstanceSettings | undefined {
    return this.settingsMapByUid[uid];
  }

  // 获取数据源的配置信息。添加数据源时配置的那些东西。
  getInstanceSettings(
    ref: string | null | undefined | DataSourceRef,
    scopedVars?: ScopedVars
  ): DataSourceInstanceSettings | undefined {
    let nameOrUid = getNameOrUid(ref);

    // Expressions has a new UID as __expr__ See: https://github.com/grafana/grafana/pull/62510/
    // But we still have dashboards/panels with old expression UID (-100)
    // To support both UIDs until we migrate them all to new one, this check is necessary
    if (isExpressionReference(nameOrUid)) {
      // expression数据源就直接返回
      return expressionInstanceSettings;
    }
    // 如果是默认DataSource就直接返回。
    if (nameOrUid === 'default' || nameOrUid == null) {
      return this.settingsMapByUid[this.defaultName] ?? this.settingsMapByName[this.defaultName];
    }

    // Complex logic to support template variable data source names
    // For this we just pick the current or first data source in the variable
    if (nameOrUid[0] === '$') {
      // $开头说明是个变量，需要先解析变量
      // 解析出变量的实际值
      const interpolatedName = this.templateSrv.replace(nameOrUid, scopedVars, variableInterpolation);

      let dsSettings;

      if (interpolatedName === 'default') {
        dsSettings = this.settingsMapByName[this.defaultName];
      } else {
        // 支持用name获取和Uid获取
        dsSettings = this.settingsMapByUid[interpolatedName] ?? this.settingsMapByName[interpolatedName];
      }

      if (!dsSettings) {
        return undefined;
      }

      // Return an instance with un-interpolated values for name and uid
      return {
        // 返回DataSource的信息
        ...dsSettings,
        isDefault: false,
        name: nameOrUid,
        uid: nameOrUid,
        rawRef: { type: dsSettings.type, uid: dsSettings.uid },
      };
    }

    // 没有用变量时直接在map中检索后返回即可。支持uid，name，id获取。
    return this.settingsMapByUid[nameOrUid] ?? this.settingsMapByName[nameOrUid] ?? this.settingsMapById[nameOrUid];
  }

  // 获取指定的DataSource信息，支持传入变量，名称，Uid。
  get(ref?: string | DataSourceRef | null, scopedVars?: ScopedVars): Promise<DataSourceApi> {
    let nameOrUid = getNameOrUid(ref);
    if (!nameOrUid) {
      // 没有传值就用默认数据源
      return this.get(this.defaultName);
    }

    if (isExpressionReference(ref)) {
      // expression数据源
      return Promise.resolve(this.datasources[ExpressionDatasourceUID]);
    }

    // Check if nameOrUid matches a uid and then get the name
    const byName = this.settingsMapByName[nameOrUid];
    if (byName) {
      // name转为uid
      nameOrUid = byName.uid;
    }

    // This check is duplicated below, this is here mainly as performance optimization to skip interpolation
    if (this.datasources[nameOrUid]) {
      // 有缓存就走缓存
      return Promise.resolve(this.datasources[nameOrUid]);
    }

    // Interpolation here is to support template variable in data source selection
    // 解析变量
    nameOrUid = this.templateSrv.replace(nameOrUid, scopedVars, variableInterpolation);

    if (nameOrUid === 'default' && this.defaultName !== 'default') {
      return this.get(this.defaultName);
    }

    if (this.datasources[nameOrUid]) {
      // 有缓存就走缓存
      return Promise.resolve(this.datasources[nameOrUid]);
    }

    // 加载数据源，可能需要网络请求
    return this.loadDatasource(nameOrUid);
  }

  async loadDatasource(key: string): Promise<DataSourceApi<any, any>> {
    if (this.datasources[key]) {
      // 有缓存就走缓存
      return Promise.resolve(this.datasources[key]);
    }

    // find the metadata
    // 找到配置信息
    const instanceSettings = this.getInstanceSettings(key);
    if (!instanceSettings) {
      return Promise.reject({ message: `Datasource ${key} was not found` });
    }

    try {
      // 加载DataSource。可能会远程加载
      const dsPlugin = await importDataSourcePlugin(instanceSettings.meta);
      // check if its in cache now
      if (this.datasources[key]) {
        return this.datasources[key];
      }

      // If there is only one constructor argument it is instanceSettings
      // 兼容angular，不解释了。
      const useAngular = dsPlugin.DataSourceClass.length !== 1;
      let instance: DataSourceApi<any, any>;

      if (useAngular) {
        instance = getLegacyAngularInjector().instantiate(dsPlugin.DataSourceClass, {
          instanceSettings,
        });
      } else {
        // 实例化DataSource
        instance = new dsPlugin.DataSourceClass(instanceSettings);
      }

      instance.components = dsPlugin.components;

      // Some old plugins does not extend DataSourceApi so we need to manually patch them
      // 对一些老插件进行兼容
      if (!(instance instanceof DataSourceApi)) {
        const anyInstance = instance as any;
        anyInstance.name = instanceSettings.name;
        anyInstance.id = instanceSettings.id;
        anyInstance.type = instanceSettings.type;
        anyInstance.meta = instanceSettings.meta;
        anyInstance.uid = instanceSettings.uid;
        (instance as any).getRef = DataSourceApi.prototype.getRef;
      }

      // store in instance cache
      // 写入缓存
      this.datasources[key] = instance;
      this.datasources[instance.uid] = instance;
      return instance;
    } catch (err) {
      if (err instanceof Error) {
        appEvents.emit(AppEvents.alertError, [instanceSettings.name + ' plugin failed', err.toString()]);
      }
      return Promise.reject({ message: `Datasource: ${key} was not found` });
    }
  }

  getAll(): DataSourceInstanceSettings[] {
    return Object.values(this.settingsMapByName);
  }

  // 列举出所有符合条件的DataSource
  getList(filters: GetDataSourceListFilters = {}): DataSourceInstanceSettings[] {
    const base = Object.values(this.settingsMapByName).filter((x) => {
      if (x.meta.id === 'grafana' || x.meta.id === 'mixed' || x.meta.id === 'dashboard') {
        return false;
      }
      if (filters.metrics && !x.meta.metrics) {
        return false;
      }
      if (filters.tracing && !x.meta.tracing) {
        return false;
      }
      if (filters.logs && x.meta.category !== 'logging' && !x.meta.logs) {
        return false;
      }
      if (filters.annotations && !x.meta.annotations) {
        return false;
      }
      if (filters.alerting && !x.meta.alerting) {
        return false;
      }
      if (filters.pluginId && !matchPluginId(filters.pluginId, x.meta)) {
        return false;
      }
      if (filters.filter && !filters.filter(x)) {
        return false;
      }
      if (filters.type && (Array.isArray(filters.type) ? !filters.type.includes(x.type) : filters.type !== x.type)) {
        return false;
      }
      if (
        !filters.all &&
        x.meta.metrics !== true &&
        x.meta.annotations !== true &&
        x.meta.tracing !== true &&
        x.meta.logs !== true &&
        x.meta.alerting !== true
      ) {
        return false;
      }
      return true;
    });

    if (filters.variables) {
      // 用于筛选出DataSource变量的选项
      for (const variable of this.templateSrv.getVariables()) {
        if (variable.type !== 'datasource') {
          continue;
        }
        let dsValue = variable.current.value === 'default' ? this.defaultName : variable.current.value;
        if (Array.isArray(dsValue) && dsValue.length === 1) {
          // Support for multi-value variables with only one selected datasource
          dsValue = dsValue[0];
        }
        const dsSettings =
          !Array.isArray(dsValue) && (this.settingsMapByName[dsValue] || this.settingsMapByUid[dsValue]);

        if (dsSettings) {
          const key = `$\{${variable.name}\}`;
          base.push({
            ...dsSettings,
            isDefault: false,
            name: key,
            uid: key,
          });
        }
      }
    }

    const sorted = base.sort((a, b) => {
      if (a.name.toLowerCase() > b.name.toLowerCase()) {
        return 1;
      }
      if (a.name.toLowerCase() < b.name.toLowerCase()) {
        return -1;
      }
      return 0;
    });

    if (!filters.pluginId && !filters.alerting) {
      if (filters.mixed) {
        const mixedInstanceSettings = this.getInstanceSettings('-- Mixed --');
        if (mixedInstanceSettings) {
          base.push(mixedInstanceSettings);
        }
      }

      if (filters.dashboard) {
        const dashboardInstanceSettings = this.getInstanceSettings('-- Dashboard --');
        if (dashboardInstanceSettings) {
          base.push(dashboardInstanceSettings);
        }
      }

      if (!filters.tracing) {
        const grafanaInstanceSettings = this.getInstanceSettings('-- Grafana --');
        if (grafanaInstanceSettings) {
          base.push(grafanaInstanceSettings);
        }
      }
    }

    return sorted;
  }

  /**
   * @deprecated use getList
   * */
  getExternal(): DataSourceInstanceSettings[] {
    return this.getList();
  }

  /**
   * @deprecated use getList
   * */
  getAnnotationSources() {
    return this.getList({ annotations: true, variables: true }).map((x) => {
      return {
        name: x.name,
        value: x.name,
        meta: x.meta,
      };
    });
  }

  /**
   * @deprecated use getList
   * */
  getMetricSources(options?: { skipVariables?: boolean }): DataSourceSelectItem[] {
    return this.getList({ metrics: true, variables: !options?.skipVariables }).map((x) => {
      return {
        name: x.name,
        value: x.name,
        meta: x.meta,
      };
    });
  }

  async reload() {
    // 重新从服务端拉取配置，重新初始化
    const settings = await getBackendSrv().get('/api/frontend/settings');
    config.datasources = settings.datasources;
    config.defaultDatasource = settings.defaultDatasource;
    this.init(settings.datasources, settings.defaultDatasource);
  }
}

export function getNameOrUid(ref?: string | DataSourceRef | null): string | undefined {
  // 如果是expression就直接返回expression dataSource
  if (isExpressionReference(ref)) {
    return ExpressionDatasourceRef.uid;
  }
  // 确保返回的是一个String。name或者是uid。
  const isString = typeof ref === 'string';
  return isString ? ref : ref?.uid;
}

export function variableInterpolation<T>(value: T | T[]) {
  // 如果是个多选的变量就直接用选中的第一个
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

// 用于获取@grafana/runtime里存的datasourceSrv实例。实例在public/app/app.ts里进行实例化的。
export const getDatasourceSrv = (): DatasourceSrv => {
  return getDataSourceService() as DatasourceSrv;
};
