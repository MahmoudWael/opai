import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isTabKey,
  isUpKey,
  makeTheme,
  Separator,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState
} from '@inquirer/core';
import { isQuickBackKey } from './back.js';

type SearchTheme = {
  icon: { cursor: string };
  style: {
    /** Styles disabled choices. */
    disabled: (text: string) => string;
    /** Styles the active search term. */
    searchTerm: (text: string) => string;
    /** Styles choice descriptions. */
    description: (text: string) => string;
    /** Formats the prompt's keyboard help. */
    keysHelpTip: (keys: [key: string, action: string][]) => string | undefined;
  };
  helpMode: 'always' | 'never' | 'auto';
};

export type SearchChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
};

type NormalizedChoice<Value> = Required<Pick<SearchChoice<Value>, 'value' | 'name' | 'short' | 'disabled'>> & Pick<SearchChoice<Value>, 'description'>;

export type PersistentSearchConfig<Value> = {
  message: string;
  /** Produces filtered choices for the current search term. */
  source: (term: string | undefined, options: { signal: AbortSignal }) => readonly (SearchChoice<Value> | Separator)[] | Promise<readonly (SearchChoice<Value> | Separator)[]>;
  /** Validates the selected value before completing the prompt. */
  validate?: (value: Value) => boolean | string | Promise<boolean | string>;
  pageSize?: number;
  initialTerm?: string;
  defaultValue?: Value;
  /** Compares a choice with the preferred initial selection. */
  equal?: (left: Value, right: Value) => boolean;
  backValue?: Value;
  instructions?: { navigation: string; pager: string };
  theme?: unknown;
};

const baseTheme: SearchTheme = {
  icon: { cursor: '❯' },
  style: {
    /** Prefixes disabled choices with a dash. */
    disabled: text => `- ${text}`,
    /** Leaves search text unchanged by default. */
    searchTerm: text => text,
    /** Leaves descriptions unchanged by default. */
    description: text => text,
    /** Joins key-action pairs into one help line. */
    keysHelpTip: keys => keys.map(([key, action]) => `${key} ${action}`).join(' · ')
  },
  helpMode: 'always'
};

/** Reports whether a normalized search item can receive selection focus. */
function selectable<Value>(item: NormalizedChoice<Value> | Separator): item is NormalizedChoice<Value> {
  return !Separator.isSeparator(item) && !item.disabled;
}

/** Fills optional choice fields while preserving separators. */
function normalize<Value>(choices: readonly (SearchChoice<Value> | Separator)[]): (NormalizedChoice<Value> | Separator)[] {
  return choices.map(choice => {
    if (Separator.isSeparator(choice)) return choice;
    const name = choice.name ?? String(choice.value);
    return { value: choice.value, name, short: choice.short ?? name, disabled: choice.disabled ?? false, description: choice.description };
  });
}

/** Runs a searchable prompt that preserves filter text and selection state. */
export const persistentSearch = createPrompt(<Value>(config: PersistentSearchConfig<Value>, done: (value: Value) => void) => {
  const { pageSize = 7, validate = () => true } = config;
  const theme = makeTheme(baseTheme, config.theme as never);
  const [status, setStatus] = useState<'loading' | 'idle' | 'done'>('loading');
  const [searchTerm, setSearchTerm] = useState(config.initialTerm ?? '');
  const [searchResults, setSearchResults] = useState<(NormalizedChoice<Value> | Separator)[]>([]);
  const [searchError, setSearchError] = useState<string>();
  const prefix = usePrefix({ status, theme });
  const bounds = useMemo(() => {
    const first = searchResults.findIndex(selectable);
    let last = -1;
    for (let index = searchResults.length - 1; index >= 0; index--) if (selectable(searchResults[index]!)) { last = index; break; }
    return { first, last };
  }, [searchResults]);
  const [active = bounds.first, setActive] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setSearchError(undefined);
    void Promise.resolve(config.source(searchTerm || undefined, { signal: controller.signal })).then(results => {
      if (controller.signal.aborted) return;
      const normalized = normalize(results);
      const preferred = config.defaultValue === undefined ? -1 : normalized.findIndex(item => selectable(item) && (config.equal?.(item.value, config.defaultValue!) ?? Object.is(item.value, config.defaultValue)));
      setActive(preferred >= 0 ? preferred : undefined);
      setSearchResults(normalized);
      setStatus('idle');
    }).catch(error => {
      if (!controller.signal.aborted && error instanceof Error) {
        setSearchError(error.message);
        setStatus('idle');
      }
    });
    return () => controller.abort();
  }, [searchTerm]);

  const selected = searchResults[active];
  const selectedChoice = selected && selectable(selected) ? selected : undefined;
  useKeypress(async (key, readline) => {
    if (config.backValue !== undefined && isQuickBackKey(key) && readline.line.length === 0) {
      setStatus('done');
      done(config.backValue);
    } else if (isEnterKey(key)) {
      if (selectedChoice) {
        setStatus('loading');
        const valid = await validate(selectedChoice.value);
        setStatus('idle');
        if (valid === true) { setStatus('done'); done(selectedChoice.value); }
        else setSearchError(valid || 'You must provide a valid value');
      } else readline.write(searchTerm);
    } else if (isTabKey(key) && selectedChoice) {
      readline.clearLine(0);
      readline.write(selectedChoice.name);
      setSearchTerm(selectedChoice.name);
    } else if (status !== 'loading' && (isUpKey(key) || isDownKey(key))) {
      readline.clearLine(0);
      if ((isUpKey(key) && active !== bounds.first) || (isDownKey(key) && active !== bounds.last)) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do { next = (next + offset + searchResults.length) % searchResults.length; }
        while (!selectable(searchResults[next]!));
        setActive(next);
      }
    } else setSearchTerm(readline.line);
  });

  const page = usePagination({
    items: searchResults,
    active,
    pageSize,
    loop: false,
    /** Renders one separator, disabled choice, or selectable result. */
    renderItem({ item, isActive }) {
      if (Separator.isSeparator(item)) return ` ${item.separator}`;
      if (item.disabled) return theme.style.disabled(`${item.name} ${typeof item.disabled === 'string' ? item.disabled : '(disabled)'}`);
      const style = isActive ? theme.style.highlight : (text: string) => text;
      return style(`${isActive ? theme.icon.cursor : ' '} ${item.name}`);
    }
  });
  const message = theme.style.message(config.message, status);
  const helpText = config.instructions
    ? (searchResults.length > pageSize ? config.instructions.pager : config.instructions.navigation)
    : theme.style.keysHelpTip([['↑↓', 'navigate'], ['⏎', 'select']]);
  const help = theme.helpMode === 'never' || !helpText ? undefined : theme.style.help(helpText);
  if (status === 'done' && selectedChoice) return [prefix, message, theme.style.answer(selectedChoice.short)].filter(Boolean).join(' ').trimEnd();
  const error = searchError ? theme.style.error(searchError) : status === 'idle' && searchResults.length === 0 && searchTerm ? theme.style.error('No results found') : undefined;
  const header = [prefix, message, theme.style.searchTerm(searchTerm)].filter(Boolean).join(' ').trimEnd();
  const body = [error ?? page, ' ', selectedChoice?.description ? theme.style.description(selectedChoice.description) : '', help].filter(Boolean).join('\n').trimEnd();
  return [header, body];
});
