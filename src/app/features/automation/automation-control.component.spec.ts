import { TestBed } from '@angular/core/testing';
import { WidgetLayoutService } from '@axe/application/ui/widget-layout.service';
import { WIDGET_AUTOMATION } from '@axe/application/ui/widget-place';
import { AutomationControlComponent } from '@axe/features/automation/automation-control.component';
import { TEST_PROVIDERS } from '@axe/testing/test-providers';

describe('AutomationControlComponent', () => {
  function create() {
    TestBed.configureTestingModule({ imports: [AutomationControlComponent], providers: [...TEST_PROVIDERS] });
    const fixture = TestBed.createComponent(AutomationControlComponent);
    fixture.detectChanges();
    const panel = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '[data-testid="automation-control"]'
    )!;
    return { fixture, panel };
  }

  afterEach(() => localStorage.clear());

  it('can be dragged, and remembers where it was left as a widget of its own', async () => {
    const { fixture, panel } = create();
    await fixture.whenStable();

    expect(panel.hasAttribute('appdraggable')).toBe(true);
    panel.style.left = '40px';
    panel.style.top = '60px';
    fixture.destroy();

    expect(TestBed.inject(WidgetLayoutService).spotOf(WIDGET_AUTOMATION)).toEqual({ left: 40, top: 60 });
  });

  it('opens at the bottom-right corner until it is moved', () => {
    const { fixture } = create();
    const fallback = (fixture.componentInstance as unknown as { fallback: (el: HTMLElement) => unknown }).fallback;
    const element = { offsetWidth: 200, offsetHeight: 50 } as HTMLElement;

    expect(fallback(element)).toEqual({ left: window.innerWidth - 212, top: window.innerHeight - 62 });
  });

  it('pushes itself back into view when opening makes it run off the bottom', async () => {
    const { fixture, panel } = create();
    await fixture.whenStable();
    panel.style.top = `${window.innerHeight + 500}px`;

    fixture.componentInstance.expanded.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(parseFloat(panel.style.top)).toBeLessThan(window.innerHeight);
  });
});
